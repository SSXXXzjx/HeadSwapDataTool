"use strict";

window.DatasetStore = (() => {
  const slots = { reference: "control_2", target: "target", result: "control_1" };
  let databasePromise;

  function database() {
    databasePromise ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("head-swap-dataset-studio", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("groups", { keyPath: "id" });
        request.result.createObjectStore("settings");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return databasePromise;
  }

  function transactionComplete(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || new Error("浏览器草稿保存被中断"));
      transaction.onerror = () => reject(transaction.error);
    });
  }

  function readRequest(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function restore() {
    const connection = await database();
    const transaction = connection.transaction(["groups", "settings"], "readonly");
    const [groups, settings] = await Promise.all([
      readRequest(transaction.objectStore("groups").getAll()),
      readRequest(transaction.objectStore("settings").get("workspace"))
    ]);
    return { groups: groups.sort((first, second) => first.id - second.id), settings };
  }

  async function save(group, settings) {
    const connection = await database();
    const transaction = connection.transaction(["groups", "settings"], "readwrite");
    const completed = transactionComplete(transaction);
    if (group) transaction.objectStore("groups").put(group);
    transaction.objectStore("settings").put(settings, "workspace");
    await completed;
  }

  async function replaceWorkspace(groups, settings) {
    const connection = await database();
    const transaction = connection.transaction(["groups", "settings"], "readwrite");
    const completed = transactionComplete(transaction);
    transaction.objectStore("groups").clear();
    for (const group of groups) transaction.objectStore("groups").put(group);
    transaction.objectStore("settings").put(settings, "workspace");
    await completed;
  }

  async function saveGroups(groups, settings) {
    const connection = await database();
    const transaction = connection.transaction(["groups", "settings"], "readwrite");
    const completed = transactionComplete(transaction);
    for (const group of groups) transaction.objectStore("groups").put(group);
    transaction.objectStore("settings").put(settings, "workspace");
    await completed;
  }

  function filename(id) {
    return String(id).padStart(6, "0");
  }

  function emptyGroup(id) {
    return { id, images: { reference: null, target: null, result: null }, prompt: "", dirtySlots: [], promptDirty: false };
  }

  async function convertImage(file) {
    if (!file || !file.type.startsWith("image/")) throw new Error("请选择图片文件");
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("无法读取图片，请重试");
      context.drawImage(bitmap, 0, 0);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("图片尺寸过大或转换失败");
      return { blob, width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }

  async function writeFile(directory, name, content) {
    const file = await directory.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    try {
      await writable.write(content);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => {});
      throw error;
    }
  }

  async function writeGroup(root, group) {
    const basename = filename(group.id);
    for (const slot of group.dirtySlots) {
      if (!group.images[slot]) continue;
      const directory = await root.getDirectoryHandle(slots[slot], { create: true });
      await writeFile(directory, `${basename}.png`, group.images[slot].blob);
    }
    if (group.promptDirty || group.dirtySlots.length) {
      const directory = await root.getDirectoryHandle("target", { create: true });
      await writeFile(directory, `${basename}.txt`, group.prompt);
    }
  }

  async function validateDirectory(root) {
    if (!root || root.kind !== "directory") throw new Error("请选择有效的保存文件夹");
    if (await root.queryPermission({ mode: "readwrite" }) !== "granted") {
      throw new Error("保存文件夹没有读写权限，请重新选择并允许访问");
    }
    for (const name of Object.values(slots)) {
      const directory = await root.getDirectoryHandle(name, { create: true });
      const probeName = `.head-swap-write-check-${crypto.randomUUID()}.tmp`;
      let created = false;
      try {
        const handle = await directory.getFileHandle(probeName, { create: true });
        created = true;
        const stream = await handle.createWritable();
        try {
          await stream.write("head-swap-dataset");
          await stream.close();
        } catch (error) {
          await stream.abort().catch(() => {});
          throw error;
        }
      } finally {
        if (created) await directory.removeEntry(probeName);
      }
    }
  }

  async function loadDirectory(root) {
    const groups = new Map();
    const findGroup = id => {
      if (!groups.has(id)) groups.set(id, emptyGroup(id));
      return groups.get(id);
    };
    for (const [slot, directoryName] of Object.entries(slots)) {
      let directory;
      try {
        directory = await root.getDirectoryHandle(directoryName);
      } catch (error) {
        if (error.name === "NotFoundError") continue;
        throw error;
      }
      for await (const [name, handle] of directory.entries()) {
        if (handle.kind !== "file") continue;
        const match = /^(\d{6,})\.(png|txt)$/i.exec(name);
        if (!match) continue;
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id) || id < 1) continue;
        if (match[2].toLowerCase() === "txt" && slot !== "target") continue;
        const group = findGroup(id);
        const file = await handle.getFile();
        if (match[2].toLowerCase() === "txt") {
          group.prompt = await file.text();
        } else {
          const blob = new Blob([await file.arrayBuffer()], { type: "image/png" });
          const bitmap = await createImageBitmap(blob);
          group.images[slot] = { blob, width: bitmap.width, height: bitmap.height };
          bitmap.close();
        }
      }
    }
    return [...groups.values()].sort((first, second) => first.id - second.id);
  }

  return { slots, restore, save, saveGroups, replaceWorkspace, filename, emptyGroup, convertImage, writeGroup, validateDirectory, loadDirectory };
})();
