"use strict";

(() => {
  const store = window.DatasetStore;
  const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map(element => [element.id, element]));
  const cards = [...document.querySelectorAll(".image-card")];
  const labels = { reference: "参考人头", target: "人物底图", result: "换头结果" };
  const state = { groups: [], index: 0, activeSlot: "reference", directory: null, directoryReady: false, busy: true, saving: false, failed: false };
  const imageUrls = new Map();
  let queue = Promise.resolve();
  let promptTimer;
  let toastTimer;
  let revision = 0;
  let dialogActive = false;

  const currentGroup = () => state.groups[state.index];
  const isComplete = group => Object.keys(store.slots).every(slot => group.images[slot]);
  const hasContent = group => group.prompt || Object.values(group.images).some(Boolean);
  const settings = () => ({ index: state.index, directory: state.directory });

  function setStatus(message, status = "saved") {
    elements["save-status"].dataset.state = status;
    elements["save-status"].querySelector("span").textContent = message;
  }

  function toast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 3500);
  }

  function message(title, text, confirmLabel = "确定", cancellable = false) {
    if (dialogActive) return Promise.resolve(false);
    dialogActive = true;
    const dialog = elements["message-dialog"];
    elements["dialog-title"].textContent = title;
    elements["dialog-message"].textContent = text;
    elements["dialog-confirm"].textContent = confirmLabel;
    elements["dialog-cancel"].hidden = !cancellable;
    dialog.returnValue = "cancel";
    dialog.showModal();
    (cancellable ? elements["dialog-cancel"] : elements["dialog-confirm"]).focus();
    return new Promise(resolve => {
      dialog.addEventListener("close", () => {
        dialogActive = false;
        resolve(dialog.returnValue === "confirm");
      }, { once: true });
    });
  }

  function setActive(slot) {
    state.activeSlot = slot;
    for (const card of cards) {
      const selected = card.dataset.slot === slot;
      card.classList.toggle("active", selected);
      card.querySelector(".image-stage").setAttribute("aria-pressed", String(selected));
    }
  }

  function setBusy(busy) {
    state.busy = busy;
    const locked = busy || !state.directoryReady;
    for (const button of document.querySelectorAll(".workspace button")) button.disabled = locked;
    elements["folder-button"].disabled = busy;
    elements["directory-confirm"].disabled = busy;
    elements.prompt.disabled = locked;
    elements["group-select"].disabled = locked;
    elements["previous-button"].disabled = locked || state.index === 0;
    for (const card of cards) {
      card.querySelector(".image-input").disabled = locked;
      card.tabIndex = locked ? -1 : 0;
      card.setAttribute("aria-disabled", String(locked));
    }
  }

  function requireDirectory(reason) {
    state.directoryReady = false;
    elements["directory-message"].textContent = reason || "请选择有效且可写入的数据集文件夹，完成后开始编辑。";
    setStatus("请先确定保存路径", "error");
    render();
    if (!elements["directory-dialog"].open) elements["directory-dialog"].showModal();
  }

  function canEdit() {
    if (state.busy || dialogActive) return false;
    if (!state.directoryReady) {
      requireDirectory();
      return false;
    }
    return true;
  }

  function renderSummary() {
    const group = currentGroup();
    const filled = Object.values(group.images).filter(Boolean).length;
    elements["filled-count"].textContent = filled;
    elements["completion-progress"].style.width = `${filled / 3 * 100}%`;
    elements["group-badge"].textContent = filled === 3 ? "已完成" : "待完成";
    elements["group-badge"].classList.toggle("complete", filled === 3);
    elements["completed-total"].textContent = state.groups.filter(isComplete).length;
    elements["total-groups"].textContent = state.groups.length;
    elements["group-select"].replaceChildren(...state.groups.map((item, index) => {
      const option = new Option(`${store.filename(item.id)}${isComplete(item) ? "  ✓" : ""}`, index);
      option.selected = index === state.index;
      return option;
    }));
  }

  function imageRatio(width, height) {
    let divisor = width;
    let remainder = height;
    while (remainder) {
      const previous = remainder;
      remainder = divisor % remainder;
      divisor = previous;
    }
    return `${width / divisor}:${height / divisor}`;
  }

  function fileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(2)} KiB`;
    return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  }

  function renderImageInfo(element, image) {
    if (!image) {
      element.textContent = "等待图片";
      element.removeAttribute("title");
      return;
    }
    const dimensions = document.createElement("span");
    dimensions.className = "image-dimensions";
    dimensions.textContent = `${image.width} × ${image.height} px`;
    const details = document.createElement("span");
    details.className = "image-details";
    details.textContent = `${imageRatio(image.width, image.height)} · ${fileSize(image.blob.size)} · PNG`;
    element.replaceChildren(dimensions, details);
    element.title = `尺寸：${dimensions.textContent}\n宽高比：${imageRatio(image.width, image.height)}\nPNG 文件大小：${fileSize(image.blob.size)}（${image.blob.size} 字节）`;
  }

  function render() {
    const group = currentGroup();
    for (const url of imageUrls.values()) URL.revokeObjectURL(url);
    imageUrls.clear();
    elements["group-number"].textContent = store.filename(group.id);
    elements["prompt-file"].textContent = `target / ${store.filename(group.id)}.txt`;
    elements.prompt.value = group.prompt;
    elements["folder-label"].textContent = state.directory ? (state.directoryReady ? state.directory.name : "重新连接文件夹") : "选择数据集文件夹";
    elements["folder-button"].title = state.directory?.name || "选择保存位置，自动创建 head_swap_dataset";
    for (const card of cards) {
      const slot = card.dataset.slot;
      const image = group.images[slot];
      const imageElement = card.querySelector(".card-image");
      card.classList.toggle("has-image", Boolean(image));
      card.querySelector(".empty-state").hidden = Boolean(image);
      card.querySelector(".preview-button").hidden = !image;
      const chooseButton = card.querySelector(".choose-image-button");
      chooseButton.querySelector("span").textContent = image ? "替换图片" : "选择图片";
      chooseButton.setAttribute("aria-label", `${image ? "替换" : "选择"}${labels[slot]}图片`);
      imageElement.hidden = !image;
      card.querySelector(".image-stage").setAttribute("aria-label", `选中${labels[slot]}粘贴区`);
      if (image) {
        const url = URL.createObjectURL(image.blob);
        imageUrls.set(slot, url);
        imageElement.src = url;
      } else {
        imageElement.removeAttribute("src");
      }
      renderImageInfo(card.querySelector(".image-info"), image);
    }
    renderSummary();
    setBusy(state.busy);
  }

  function scheduleSave() {
    const group = currentGroup();
    const snapshot = structuredClone(group);
    const capturedSettings = settings();
    const capturedDirectory = state.directoryReady ? state.directory : null;
    const saveRevision = ++revision;
    state.failed = false;
    state.saving = true;
    setStatus("正在保存", "pending");
    queue = queue.catch(() => {}).then(async () => {
      await store.save(snapshot, capturedSettings);
      if (capturedDirectory && (snapshot.dirtySlots.length || snapshot.promptDirty)) {
        await store.writeGroup(capturedDirectory, snapshot);
        if (saveRevision === revision) {
          group.dirtySlots = [];
          group.promptDirty = false;
          await store.save(group, capturedSettings);
        }
      }
    }).then(() => {
      if (saveRevision !== revision) return;
      state.saving = false;
      setStatus(capturedDirectory ? "已自动保存" : state.directory ? "草稿已保存 · 待连接" : "浏览器草稿已保存");
    }).catch(error => {
      if (saveRevision !== revision) return;
      state.saving = false;
      state.failed = true;
      state.directoryReady = false;
      setStatus("保存失败 · 点击重试", "error");
      toast(`保存失败：${error.message}。请连接文件夹后重试。`);
      requireDirectory(`保存路径当前无法写入：${error.message}。请重新确定保存路径。`);
    });
    return queue;
  }

  async function flush() {
    if (promptTimer) {
      clearTimeout(promptTimer);
      promptTimer = null;
      scheduleSave();
    }
    await queue;
    if (state.failed) {
      await message("保存未完成", "请检查文件夹权限和磁盘空间，再点击保存状态重试。");
      return false;
    }
    return true;
  }

  async function addImage(slot, file) {
    if (!file || !canEdit()) return;
    setActive(slot);
    setBusy(true);
    try {
      if (currentGroup().images[slot]) {
        const confirmed = await message("替换图片？", `将替换第 ${store.filename(currentGroup().id)} 组的${labels[slot]}。`, "确认替换", true);
        if (!confirmed) return;
      }
      setStatus("正在处理图片", "pending");
      const image = await store.convertImage(file);
      const group = currentGroup();
      group.images[slot] = image;
      if (!group.dirtySlots.includes(slot)) group.dirtySlots.push(slot);
      group.promptDirty = true;
      render();
      await scheduleSave();
    } catch (error) {
      await message("图片未添加", error.message || "无法读取这张图片，请换一张图片重试。");
      setStatus(state.failed ? "保存失败 · 点击重试" : "图片未添加", state.failed ? "error" : "saved");
    } finally {
      setBusy(false);
    }
  }

  async function navigate(index) {
    if (!canEdit()) return;
    if (index > state.index && !isComplete(currentGroup())) {
      elements["group-select"].value = state.index;
      const missing = Object.keys(labels).filter(slot => !currentGroup().images[slot]).map(slot => labels[slot]);
      await message("请先完成当前组", `还缺少：${missing.join("、")}。\n三张图片齐全后才能进入下一组。`, "继续编辑");
      return;
    }
    setBusy(true);
    try {
      if (!await flush()) return;
      if (index >= state.groups.length) {
        const id = Math.max(...state.groups.map(group => group.id)) + 1;
        state.groups.push(store.emptyGroup(id));
      }
      state.index = Math.max(0, Math.min(index, state.groups.length - 1));
      render();
      await scheduleSave();
    } finally {
      setBusy(false);
    }
  }

  async function applyPromptToAll() {
    if (!canEdit()) return;
    const prompt = elements.prompt.value;
    setBusy(true);
    try {
      const confirmed = await message("应用到全部组？", `将用当前${prompt ? "提示词" : "空提示词"}覆盖现有 ${state.groups.length} 组的提示词，并自动保存。`, "确认应用", true);
      if (!confirmed || !await flush()) return;
      for (const group of state.groups) {
        group.prompt = prompt;
        group.promptDirty = true;
      }
      const snapshot = structuredClone(state.groups);
      const capturedSettings = settings();
      const directory = state.directory;
      revision++;
      state.saving = true;
      state.failed = false;
      setStatus("正在应用提示词", "pending");
      queue = queue.catch(() => {}).then(async () => {
        await store.saveGroups(snapshot, capturedSettings);
        for (const group of state.groups) {
          await store.writeGroup(directory, group);
          group.promptDirty = false;
          await store.save(group, capturedSettings);
        }
      }).then(() => {
        setStatus("已自动保存");
        toast(`已应用到全部 ${state.groups.length} 组`);
      }).catch(error => {
        state.failed = true;
        requireDirectory(`批量保存未完成：${error.message}。请重新确定保存路径后继续保存。`);
      }).finally(() => { state.saving = false; });
      await queue;
    } finally {
      setBusy(false);
    }
  }

  async function connectDirectory() {
    if (state.busy || dialogActive) return;
    if (!window.showDirectoryPicker) {
      await message("请使用 Edge 或 Chrome", "此浏览器不支持文件夹自动保存。请用电脑端 Edge 或 Chrome 打开本页面。");
      return;
    }
    setBusy(true);
    try {
      const selected = await window.showDirectoryPicker({ id: "head-swap-dataset", mode: "readwrite" });
      if (promptTimer) {
        clearTimeout(promptTimer);
        promptTimer = null;
        scheduleSave();
      }
      await queue;
      await store.save(currentGroup(), settings());
      let root = selected;
      if (selected.name !== "head_swap_dataset") {
        let isDataset = false;
        for (const name of Object.values(store.slots)) {
          try { await selected.getDirectoryHandle(name); isDataset = true; break; }
          catch (error) { if (error.name !== "NotFoundError") throw error; }
        }
        if (!isDataset) root = await selected.getDirectoryHandle("head_swap_dataset", { create: true });
      }
      await store.validateDirectory(root);
      const sameDirectory = state.directory && await state.directory.isSameEntry(root);
      const imported = sameDirectory ? [] : await store.loadDirectory(root);
      if (imported.length) {
        if (state.groups.some(hasContent)) {
          const confirmed = await message("载入已有数据集？", "将显示此文件夹中的分组，并替换当前浏览器草稿。", "载入数据集", true);
          if (!confirmed) return;
        }
        await store.replaceWorkspace(imported, { index: 0, directory: root });
        state.groups = imported;
        state.index = 0;
      } else if (!sameDirectory) {
        for (const group of state.groups) {
          group.dirtySlots = Object.keys(store.slots).filter(slot => group.images[slot]);
          group.promptDirty = Boolean(hasContent(group));
        }
      }
      state.directory = root;
      state.directoryReady = true;
      setStatus("正在同步文件夹", "pending");
      for (const group of state.groups) {
        if (!group.dirtySlots.length && !group.promptDirty) continue;
        await store.save(group, settings());
        await store.writeGroup(root, group);
        group.dirtySlots = [];
        group.promptDirty = false;
        await store.save(group, settings());
      }
      await store.save(currentGroup(), settings());
      state.failed = false;
      render();
      setStatus("已自动保存");
      elements["directory-dialog"].close();
      toast(imported.length ? `已载入 ${imported.length} 组` : "已连接，后续修改自动保存");
    } catch (error) {
      if (error.name !== "AbortError") {
        state.directoryReady = false;
        state.failed = true;
        await message("文件夹未连接", error.message || "请检查访问权限后重试。");
        requireDirectory(`保存路径校验失败：${error.message}。请重新选择有效且可写入的文件夹。`);
      }
    } finally {
      if (!state.directoryReady) requireDirectory(elements["directory-message"].textContent);
      render();
      setBusy(false);
    }
  }

  function showPreview(slot) {
    const image = currentGroup().images[slot];
    if (!image) return;
    elements["preview-image"].src = imageUrls.get(slot);
    elements["preview-label"].textContent = `${store.filename(currentGroup().id)} / ${labels[slot]}`;
    elements["preview-size"].textContent = `${image.width} × ${image.height}`;
    elements["preview-dialog"].showModal();
  }

  for (const card of cards) {
    const slot = card.dataset.slot;
    const input = card.querySelector(".image-input");
    card.addEventListener("pointerdown", () => { if (canEdit()) setActive(slot); });
    card.addEventListener("focusin", () => { if (canEdit()) setActive(slot); });
    card.addEventListener("keydown", event => {
      if (event.target === card && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        card.querySelector(".image-stage").click();
      }
    });
    card.querySelector(".image-stage").addEventListener("click", () => {
      if (!canEdit()) return;
      setActive(slot);
    });
    card.querySelector(".choose-image-button").addEventListener("click", () => {
      if (!canEdit()) return;
      setActive(slot);
      input.click();
    });
    card.querySelector(".preview-button").addEventListener("click", () => {
      if (canEdit()) showPreview(slot);
    });
    input.addEventListener("change", () => { const file = input.files[0]; input.value = ""; void addImage(slot, file); });
    let dragDepth = 0;
    card.addEventListener("dragenter", event => { event.preventDefault(); dragDepth++; if (!state.busy && state.directoryReady) card.classList.add("dragging"); });
    card.addEventListener("dragover", event => { event.preventDefault(); event.dataTransfer.dropEffect = state.busy || !state.directoryReady ? "none" : "copy"; });
    card.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; card.classList.remove("dragging"); } });
    card.addEventListener("drop", event => {
      event.preventDefault();
      dragDepth = 0;
      card.classList.remove("dragging");
      const file = [...event.dataTransfer.files].find(item => item.type.startsWith("image/"));
      if (file) void addImage(slot, file);
      else toast("请拖入图片文件");
    });
  }

  document.addEventListener("dragover", event => event.preventDefault());
  document.addEventListener("drop", event => event.preventDefault());
  document.addEventListener("paste", event => {
    if (state.busy || dialogActive || elements["preview-dialog"].open || event.target.closest?.("textarea, input")) return;
    const image = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith("image/"));
    if (image) { event.preventDefault(); void addImage(state.activeSlot, image.getAsFile()); }
  });
  elements.prompt.addEventListener("input", () => {
    if (!canEdit()) { elements.prompt.value = currentGroup().prompt; return; }
    revision++;
    state.saving = true;
    currentGroup().prompt = elements.prompt.value;
    currentGroup().promptDirty = true;
    setStatus("正在保存", "pending");
    clearTimeout(promptTimer);
    promptTimer = setTimeout(() => { promptTimer = null; scheduleSave(); }, 300);
  });
  elements.prompt.addEventListener("blur", () => {
    if (promptTimer) { clearTimeout(promptTimer); promptTimer = null; scheduleSave(); }
  });
  elements["next-button"].addEventListener("click", () => { void navigate(state.index + 1); });
  elements["previous-button"].addEventListener("click", () => { void navigate(state.index - 1); });
  elements["group-select"].addEventListener("change", event => { void navigate(Number(event.target.value)); });
  elements["folder-button"].addEventListener("click", () => { void connectDirectory(); });
  elements["apply-prompt-all"].addEventListener("click", () => { void applyPromptToAll(); });
  elements["directory-confirm"].addEventListener("click", () => { void connectDirectory(); });
  elements["directory-dialog"].addEventListener("cancel", event => event.preventDefault());
  elements["save-status"].addEventListener("click", () => {
    if (state.busy) return;
    if (state.directory && !state.directoryReady) void connectDirectory();
    else if (state.failed) scheduleSave();
  });
  elements["preview-close"].addEventListener("click", () => elements["preview-dialog"].close());
  elements["preview-dialog"].addEventListener("click", event => {
    if (event.target === elements["preview-dialog"] || event.target.classList.contains("preview-body")) elements["preview-dialog"].close();
  });
  elements["preview-dialog"].addEventListener("close", () => elements["preview-image"].removeAttribute("src"));
  document.addEventListener("keydown", event => {
    if (state.busy || dialogActive || document.querySelector("dialog[open]") || event.target.closest?.("textarea, input, select")) return;
    if (event.key === "ArrowRight") { event.preventDefault(); void navigate(state.index + 1); }
    if (event.key === "ArrowLeft" && state.index > 0) { event.preventDefault(); void navigate(state.index - 1); }
  });
  window.addEventListener("beforeunload", event => {
    if (promptTimer) { clearTimeout(promptTimer); promptTimer = null; scheduleSave(); }
    if (state.saving || state.busy || state.failed) { event.preventDefault(); event.returnValue = ""; }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && promptTimer) { clearTimeout(promptTimer); promptTimer = null; scheduleSave(); }
  });

  async function initialize() {
    setBusy(true);
    try {
      const restored = await store.restore();
      state.groups = restored.groups.length ? restored.groups : [store.emptyGroup(1)];
      state.index = Math.min(Math.max(restored.settings?.index || 0, 0), state.groups.length - 1);
      state.directory = restored.settings?.directory || null;
      if (state.directory) {
        try {
          await store.validateDirectory(state.directory);
          state.directoryReady = true;
        } catch (error) {
          state.directoryReady = false;
          elements["directory-message"].textContent = `上次的保存路径暂不可用：${error.message}。请重新确定保存路径。`;
        }
      }
      render();
      if (!state.directoryReady) {
        requireDirectory(elements["directory-message"].textContent);
        return;
      }
      if (state.directoryReady) {
        for (const group of state.groups) {
          if (!group.dirtySlots.length && !group.promptDirty) continue;
          await store.writeGroup(state.directory, group);
          group.dirtySlots = [];
          group.promptDirty = false;
          await store.save(group, settings());
        }
      }
      await scheduleSave();
      if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {});
    } catch (error) {
      state.failed = true;
      if (!state.groups.length) state.groups = [store.emptyGroup(1)];
      render();
      setStatus("草稿载入失败", "error");
      await message("草稿载入失败", `${error.message}\n请检查浏览器存储设置，或重新连接数据集文件夹。`);
      requireDirectory("初始化未完成，请重新确定有效且可写入的保存路径。");
    } finally {
      setBusy(false);
    }
  }

  void initialize();
})();
