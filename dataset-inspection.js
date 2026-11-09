"use strict";

window.DatasetInspection = (() => {
  const labels = { reference: "参考人头", target: "人物底图", result: "换头结果" };

  async function readImage(file) {
    const bytes = await file.arrayBuffer();
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (!signature.every((value, index) => new Uint8Array(bytes)[index] === value)) {
      throw new Error("文件不是有效的 PNG");
    }
    const blob = new Blob([bytes], { type: "image/png" });
    const bitmap = await createImageBitmap(blob);
    try {
      return { blob, width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  }

  async function scan(root, existingGroups, onProgress) {
    const records = new Map(existingGroups.map(group => [group.id, { group: DatasetStore.emptyGroup(group.id), files: {}, issues: [] }]));
    const findRecord = id => {
      if (!records.has(id)) records.set(id, { group: DatasetStore.emptyGroup(id), files: {}, issues: [] });
      return records.get(id);
    };
    for (const [slot, directoryName] of Object.entries(DatasetStore.slots)) {
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
        if (!match || (match[2].toLowerCase() === "txt" && slot !== "target")) continue;
        const id = Number(match[1]);
        if (!Number.isSafeInteger(id) || id < 1) continue;
        const record = findRecord(id);
        const key = match[2].toLowerCase() === "txt" ? "prompt" : slot;
        if (record.files[key]) record.issues.push(`${key === "prompt" ? "提示词" : labels[key]}存在重复编号文件`);
        record.files[key] = handle;
      }
    }
    const ordered = [...records.values()].sort((first, second) => first.group.id - second.group.id);
    for (let index = 0; index < ordered.length; index++) {
      const record = ordered[index];
      const group = record.group;
      for (const slot of Object.keys(labels)) {
        const handle = record.files[slot];
        if (!handle) {
          record.issues.push(`缺少${labels[slot]}`);
          continue;
        }
        try {
          group.images[slot] = await readImage(await handle.getFile());
        } catch (error) {
          group.imageErrors ??= {};
          group.imageErrors[slot] = `${labels[slot]}损坏或无法读取`;
          record.issues.push(`${group.imageErrors[slot]}：${error.message}`);
        }
      }
      if (!record.files.prompt) {
        record.issues.push("缺少提示词文件");
      } else {
        try {
          const file = await record.files.prompt.getFile();
          group.prompt = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
          if (!group.prompt.trim()) record.issues.push("提示词为空");
        } catch (error) {
          group.promptError = "提示词文件无法读取或不是有效的 UTF-8";
          record.issues.push(group.promptError);
        }
      }
      onProgress?.(index + 1, ordered.length);
      if (index % 10 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    return ordered;
  }

  return { scan, readImage };
})();
