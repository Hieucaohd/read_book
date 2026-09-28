pdfjsLib.GlobalWorkerOptions.workerSrc = "/vendor/pdfjs/pdf.worker.min.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const storage = {
  get(key) {
    try { return window.localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { window.localStorage.setItem(key, String(value)); } catch { /* Reading still works without saved preferences. */ }
  },
  remove(key) {
    try { window.localStorage.removeItem(key); } catch { /* Storage may be unavailable in private mode. */ }
  },
};

const elements = {
  app: $("#app"), welcome: $("#welcomeView"), reader: $("#readerView"),
  fileInput: $("#fileInput"), fileName: $("#fileName"), pageStatus: $("#pageStatus"),
  pageList: $("#pageList"), reflow: $("#reflowContent"), canvasWrap: $("#canvasContent"),
  canvas: $("#pdfCanvas"), loading: $("#loadingView"), loadingText: $("#loadingText"),
  readerNav: $("#readerNav"), navStatus: $("#navStatus"), settings: $("#settingsPanel"),
  fontValue: $("#fontValue"), lineHeight: $("#lineHeight"), sidebar: $("#sidebar"),
  searchSheet: $("#searchSheet"), searchInput: $("#searchInput"),
  searchResults: $("#searchResults"), toast: $("#toast"), dropZone: $("#dropZone"),
  selectionAction: $("#selectionAction"), selectionMenu: $("#selectionMenu"),
  vocaSheet: $("#vocaSheet"), vocaConnect: $("#vocaConnect"),
  vocaSaveForm: $("#vocaSaveForm"), vocaReady: $("#vocaReady"),
  vocaApiKey: $("#vocaApiKey"), vocaCollection: $("#vocaCollection"),
  vocaDefaultCollection: $("#vocaDefaultCollection"), vocaWord: $("#vocaWord"),
  vocaContext: $("#vocaContext"), vocaConnectMessage: $("#vocaConnectMessage"),
  vocaSaveMessage: $("#vocaSaveMessage"),
  authGate: $("#authGate"), authForm: $("#authForm"), authUsername: $("#authUsername"),
  authPassword: $("#authPassword"), authMessage: $("#authMessage"),
  userButton: $("#userButton"), userMenu: $("#userMenu"),
  libraryGrid: $("#libraryGrid"), libraryEmpty: $("#libraryEmpty"),
};

const state = {
  pdf: null,
  pages: [],
  page: 1,
  mode: "reflow",
  fontSize: Number(storage.get("reader-font-size")) || 19,
  lineHeight: Number(storage.get("reader-line-height")) || 1.7,
  theme: storage.get("reader-theme") || "sepia",
  renderTask: null,
  currentBookId: null,
};

const authState = {
  user: null,
  csrfToken: "",
  mode: "login",
};

const VOCA_API = "https://voca-zeta-five.vercel.app/api/v1";
const vocaState = {
  apiKey: "",
  collectionId: "",
  collections: [],
  selection: null,
};

function applyPreferences() {
  elements.app.dataset.theme = state.theme;
  document.documentElement.style.setProperty("--reader-font", `${state.fontSize}px`);
  document.documentElement.style.setProperty("--reader-leading", state.lineHeight);
  elements.fontValue.value = state.fontSize;
  elements.fontValue.textContent = state.fontSize;
  elements.lineHeight.value = state.lineHeight;
  $$('[data-set-theme]').forEach((button) => button.classList.toggle("active", button.dataset.setTheme === state.theme));
  document.querySelector('meta[name="theme-color"]').content = state.theme === "dark" ? "#171918" : state.theme === "light" ? "#fafaf8" : "#f5f0e8";
}

function setTheme(theme) {
  state.theme = theme;
  storage.set("reader-theme", theme);
  applyPreferences();
  scheduleSettingsSync();
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add("hidden"), 2800);
}

async function appApi(path, options = {}) {
  const headers = { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers };
  if (authState.csrfToken && options.method && options.method !== "GET") headers["X-CSRF-Token"] = authState.csrfToken;
  const response = await fetch(path, { credentials: "same-origin", ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || "Có lỗi xảy ra. Vui lòng thử lại.");
    error.status = response.status;
    error.code = data?.error?.code;
    throw error;
  }
  return data;
}

function applyAccountSettings(settings = {}) {
  state.theme = settings.theme || "sepia";
  state.fontSize = Number(settings.font_size) || 19;
  state.lineHeight = Number(settings.line_height) || 1.7;
  vocaState.collectionId = settings.voca_collection_id || "";
  storage.set("reader-theme", state.theme);
  storage.set("reader-font-size", state.fontSize);
  storage.set("reader-line-height", state.lineHeight);
  applyPreferences();
}

function scheduleSettingsSync() {
  if (!authState.user) return;
  clearTimeout(scheduleSettingsSync.timer);
  scheduleSettingsSync.timer = setTimeout(async () => {
    try {
      await appApi("/api/settings", {
        method: "PUT",
        body: JSON.stringify({
          theme: state.theme,
          font_size: state.fontSize,
          line_height: state.lineHeight,
          voca_collection_id: vocaState.collectionId,
        }),
      });
    } catch (error) {
      if (error.status === 401) showAuthGate();
      else showToast("Chưa thể đồng bộ thiết lập.");
    }
  }, 500);
}

function setAuthMode(mode) {
  authState.mode = mode;
  const registering = mode === "register";
  $("#loginTab").classList.toggle("active", !registering);
  $("#registerTab").classList.toggle("active", registering);
  $("#authTitle").textContent = registering ? "Tạo góc đọc của bạn" : "Chào bạn trở lại";
  $("#authSubtitle").textContent = registering ? "Thiết lập đọc sẽ theo bạn trên mọi thiết bị." : "Đăng nhập để đồng bộ thiết lập đọc của bạn.";
  $("#authSubmit").textContent = registering ? "Tạo tài khoản" : "Đăng nhập";
  elements.authPassword.autocomplete = registering ? "new-password" : "current-password";
  setFormMessage(elements.authMessage);
}

function showAuthGate() {
  elements.authGate.classList.remove("hidden");
  elements.userButton.classList.add("hidden");
  setTimeout(() => elements.authUsername.focus(), 50);
}

function vocaKeyForUser() {
  return authState.user ? `voca-api-key:${authState.user.id}` : "";
}

async function handleAuthenticated(data) {
  authState.user = data.user;
  authState.csrfToken = data.csrf_token;
  applyAccountSettings(data.settings);
  const scopedKey = storage.get(vocaKeyForUser());
  const legacyKey = storage.get("voca-api-key");
  vocaState.apiKey = scopedKey || legacyKey || "";
  if (!scopedKey && legacyKey) storage.set(vocaKeyForUser(), legacyKey);
  if (legacyKey) storage.remove("voca-api-key");
  vocaState.collections = [];
  setVocaConnected(Boolean(vocaState.apiKey));
  $("#userInitial").textContent = data.user.username.slice(0, 1);
  $("#userName").textContent = data.user.username;
  $("#userMenuName").textContent = data.user.username;
  elements.userButton.classList.remove("hidden");
  elements.authGate.classList.add("hidden");
  await renderLibrary();
}

async function initializeAuth() {
  try {
    await handleAuthenticated(await appApi("/api/auth/me"));
  } catch (error) {
    if (error.status !== 401) setFormMessage(elements.authMessage, "Không thể kết nối máy chủ. Hãy tải lại trang.");
    showAuthGate();
  }
}

async function submitAuth(event) {
  event.preventDefault();
  const button = $("#authSubmit");
  button.disabled = true;
  button.textContent = authState.mode === "register" ? "Đang tạo…" : "Đang đăng nhập…";
  setFormMessage(elements.authMessage);
  try {
    const data = await appApi(`/api/auth/${authState.mode}`, {
      method: "POST",
      body: JSON.stringify({ username: elements.authUsername.value.trim(), password: elements.authPassword.value }),
    });
    elements.authPassword.value = "";
    await handleAuthenticated(data);
  } catch (error) {
    setFormMessage(elements.authMessage, error.message);
  } finally {
    button.disabled = false;
    button.textContent = authState.mode === "register" ? "Tạo tài khoản" : "Đăng nhập";
  }
}

async function logoutAccount() {
  try { await appApi("/api/auth/logout", { method: "POST" }); } catch { /* The local logout still completes. */ }
  await updateCurrentBookProgress();
  if (state.pdf) await state.pdf.destroy();
  authState.user = null;
  authState.csrfToken = "";
  vocaState.apiKey = "";
  state.pdf = null;
  state.pages = [];
  state.currentBookId = null;
  elements.reader.classList.add("hidden");
  elements.welcome.classList.remove("hidden");
  elements.userMenu.classList.add("hidden");
  elements.libraryGrid.innerHTML = "";
  setVocaConnected(false);
  showAuthGate();
}

const bookDatabase = new Promise((resolve, reject) => {
  const request = indexedDB.open("trang-giay-library", 1);
  request.onupgradeneeded = () => {
    const database = request.result;
    const store = database.createObjectStore("books", { keyPath: "id" });
    store.createIndex("ownerId", "ownerId", { unique: false });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function idbRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getLocalBooks() {
  if (!authState.user) return [];
  const database = await bookDatabase;
  const transaction = database.transaction("books", "readonly");
  const books = await idbRequest(transaction.objectStore("books").index("ownerId").getAll(authState.user.id));
  return books.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
}

async function makeBookId(file) {
  const identity = `${authState.user.id}:${file.name}:${file.size}:${file.lastModified || 0}`;
  if (window.crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return encodeURIComponent(identity);
}

async function saveBookLocally(file) {
  if (!authState.user) return null;
  const database = await bookDatabase;
  const id = await makeBookId(file);
  const store = database.transaction("books", "readwrite").objectStore("books");
  const existing = await idbRequest(store.get(id));
  const record = {
    id,
    ownerId: authState.user.id,
    name: file.name,
    size: file.size,
    type: file.type || "application/pdf",
    lastModified: file.lastModified || Date.now(),
    file,
    addedAt: existing?.addedAt || Date.now(),
    lastOpenedAt: Date.now(),
    lastPage: existing?.lastPage || 1,
    totalPages: existing?.totalPages || 0,
  };
  await idbRequest(store.put(record));
  state.currentBookId = id;
  await renderLibrary();
  return record;
}

async function updateCurrentBookProgress() {
  if (!state.currentBookId || !authState.user || !state.pdf) return;
  const bookId = state.currentBookId;
  const ownerId = authState.user.id;
  const page = state.page;
  const totalPages = state.pdf.numPages;
  try {
    const database = await bookDatabase;
    const store = database.transaction("books", "readwrite").objectStore("books");
    const book = await idbRequest(store.get(bookId));
    if (!book || book.ownerId !== ownerId) return;
    book.lastPage = page;
    book.totalPages = totalPages;
    book.lastOpenedAt = Date.now();
    await idbRequest(store.put(book));
  } catch (error) {
    console.warn("Could not save reading progress", error);
  }
}

function scheduleBookProgressSave() {
  clearTimeout(scheduleBookProgressSave.timer);
  scheduleBookProgressSave.timer = setTimeout(updateCurrentBookProgress, 700);
}

async function openLocalBook(id) {
  const database = await bookDatabase;
  const book = await idbRequest(database.transaction("books", "readonly").objectStore("books").get(id));
  if (!book || book.ownerId !== authState.user?.id) return;
  const file = new File([book.file], book.name, { type: book.type, lastModified: book.lastModified });
  await openPdf(file, { bookRecord: book });
}

async function deleteLocalBook(id) {
  const books = await getLocalBooks();
  const book = books.find((item) => item.id === id);
  if (!book || !confirm(`Xóa “${book.name}” khỏi thiết bị này?`)) return;
  const database = await bookDatabase;
  await idbRequest(database.transaction("books", "readwrite").objectStore("books").delete(id));
  if (state.currentBookId === id) state.currentBookId = null;
  await renderLibrary();
  showToast("Đã xóa sách khỏi thiết bị.");
}

function formatFileSize(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

async function renderLibrary() {
  try {
    const books = await getLocalBooks();
    elements.libraryGrid.innerHTML = "";
    elements.libraryEmpty.classList.toggle("hidden", books.length > 0);
    books.forEach((book) => {
      const card = document.createElement("article");
      card.className = "book-card";
      const cover = document.createElement("div");
      cover.className = "book-card-cover";
      cover.textContent = "PDF";
      const copy = document.createElement("div");
      copy.className = "book-card-copy";
      const title = document.createElement("strong");
      title.textContent = normalizeFileName(book.name);
      const meta = document.createElement("small");
      meta.textContent = `${formatFileSize(book.size)}${book.totalPages ? ` · Trang ${book.lastPage}/${book.totalPages}` : ""}`;
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.textContent = "Đọc tiếp →";
      openButton.addEventListener("click", () => openLocalBook(book.id));
      copy.append(title, meta, openButton);
      const deleteButton = document.createElement("button");
      deleteButton.type = "button";
      deleteButton.className = "book-card-delete";
      deleteButton.setAttribute("aria-label", `Xóa ${book.name}`);
      deleteButton.textContent = "×";
      deleteButton.addEventListener("click", () => deleteLocalBook(book.id));
      card.append(cover, copy, deleteButton);
      elements.libraryGrid.append(card);
    });
  } catch (error) {
    console.error(error);
    elements.libraryEmpty.classList.remove("hidden");
    elements.libraryEmpty.querySelector("p").textContent = "Trình duyệt không cho phép lưu sách trên thiết bị này.";
  }
}

function normalizeFileName(name) {
  return name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
}

function escapeHtml(value) {
  const span = document.createElement("span");
  span.textContent = value;
  return span.innerHTML;
}

function groupTextItems(items) {
  if (!items.length) return [];
  const rows = [];
  const sorted = items.filter((item) => item.str.trim()).sort((a, b) => {
    const yDelta = b.transform[5] - a.transform[5];
    return Math.abs(yDelta) > 3 ? yDelta : a.transform[4] - b.transform[4];
  });

  for (const item of sorted) {
    const y = item.transform[5];
    let row = rows.find((candidate) => Math.abs(candidate.y - y) < Math.max(3, item.height * 0.35));
    if (!row) {
      row = { y, height: item.height || 10, items: [] };
      rows.push(row);
    }
    row.items.push(item);
  }

  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) => {
    row.items.sort((a, b) => a.transform[4] - b.transform[4]);
    let text = "";
    row.items.forEach((item, index) => {
      const previous = row.items[index - 1];
      const previousEnd = previous ? previous.transform[4] + previous.width : 0;
      const gap = item.transform[4] - previousEnd;
      const needsSpace = index > 0 && gap > Math.max(1.5, item.height * 0.12) && !/^[,.;:!?%)\]}]/.test(item.str);
      text += `${needsSpace ? " " : ""}${item.str}`;
    });
    return { text: text.trim(), y: row.y, height: row.height };
  }).filter((row) => row.text);
}

function rowsToBlocks(rows) {
  if (!rows.length) return [];
  const medianHeight = [...rows].sort((a, b) => a.height - b.height)[Math.floor(rows.length / 2)]?.height || 10;
  const blocks = [];
  let paragraph = [];

  const flush = () => {
    if (!paragraph.length) return;
    let text = paragraph.map((row) => row.text).join(" ");
    text = text.replace(/([\p{L}\p{N}])-\s+([\p{Ll}])/gu, "$1$2").replace(/\s+/g, " ").trim();
    const maxHeight = Math.max(...paragraph.map((row) => row.height));
    const isHeading = maxHeight > medianHeight * 1.25 && text.length < 140;
    blocks.push({ type: isHeading ? "heading" : "paragraph", text });
    paragraph = [];
  };

  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    const gap = previous ? previous.y - row.y - previous.height : 0;
    const beginsIndented = /^([•·▪◦‣]|\d+[.)]|[a-zA-Z][.)])\s/.test(row.text);
    const endsSentence = previous && /[.!?…:;”"]$/.test(previous.text);
    if (previous && (gap > medianHeight * 0.85 || beginsIndented || (endsSentence && previous.text.length < 70))) flush();
    paragraph.push(row);
    if (beginsIndented) flush();
  });
  flush();
  return blocks;
}

async function extractPage(pageNumber) {
  const page = await state.pdf.getPage(pageNumber);
  const content = await page.getTextContent({ includeMarkedContent: false });
  const rows = groupTextItems(content.items);
  const blocks = rowsToBlocks(rows);
  return { number: pageNumber, blocks, text: blocks.map((block) => block.text).join(" ") };
}

async function openPdf(file, options = {}) {
  if (!file || (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf"))) {
    showToast("Vui lòng chọn một file PDF.");
    return;
  }

  if (state.pdf) await state.pdf.destroy();
  let activeBook = options.bookRecord || null;
  elements.welcome.classList.add("hidden");
  elements.reader.classList.remove("hidden");
  elements.loading.classList.remove("hidden");
  elements.reflow.innerHTML = "";
  elements.readerNav.classList.add("hidden");
  elements.fileName.textContent = normalizeFileName(file.name);
  elements.pageStatus.textContent = "Đang mở file…";
  $("#searchButton").disabled = true;
  state.pages = [];
  state.page = 1;

  try {
    const data = new Uint8Array(await file.arrayBuffer());
    state.pdf = await pdfjsLib.getDocument({ data }).promise;
    if (activeBook) {
      state.currentBookId = activeBook.id;
    } else {
      try { activeBook = await saveBookLocally(file); } catch (error) {
        console.warn("Could not store PDF locally", error);
        showToast("PDF vẫn mở được nhưng chưa thể lưu vào thư viện thiết bị.");
      }
    }
    elements.pageStatus.textContent = `${state.pdf.numPages} trang`;
    buildPageList();

    for (let number = 1; number <= state.pdf.numPages; number += 1) {
      elements.loadingText.textContent = `Đang dàn lại trang ${number} / ${state.pdf.numPages}`;
      const pageData = await extractPage(number);
      state.pages.push(pageData);
      appendReflowPage(pageData);
      updatePageListItem(number, pageData);
      if (number % 5 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    }

    elements.loading.classList.add("hidden");
    elements.readerNav.classList.remove("hidden");
    $("#searchButton").disabled = false;
    state.page = Math.max(1, Math.min(activeBook?.lastPage || 1, state.pdf.numPages));
    updateNavigation();
    if (state.page > 1) goToPage(state.page);
    if (!state.pages.some((page) => page.text.trim())) {
      setMode("original");
      showToast("PDF này không có lớp chữ. Đã chuyển sang xem trang gốc.");
    }
  } catch (error) {
    console.error(error);
    elements.loading.classList.add("hidden");
    elements.reflow.innerHTML = `<div class="empty-page"><strong>Không thể mở file này</strong><p>File có thể bị hỏng hoặc được bảo vệ bằng mật khẩu.</p><button class="primary" id="retryOpen">Chọn file khác</button></div>`;
    $("#retryOpen")?.addEventListener("click", chooseFile);
  }
}

function appendReflowPage(pageData) {
  const section = document.createElement("section");
  section.className = "text-page";
  section.id = `text-page-${pageData.number}`;
  section.dataset.page = pageData.number;
  section.innerHTML = `<div class="page-kicker">TRANG ${pageData.number}</div>` + (
    pageData.blocks.length
      ? pageData.blocks.map((block) => block.type === "heading" ? `<h2>${escapeHtml(block.text)}</h2>` : `<p>${escapeHtml(block.text)}</p>`).join("")
      : `<div class="no-text"><strong>Trang này không có văn bản có thể trích xuất.</strong><button type="button" data-original-page="${pageData.number}">Xem trang gốc</button></div>`
  );
  elements.reflow.append(section);
  section.querySelector("[data-original-page]")?.addEventListener("click", () => {
    state.page = pageData.number;
    setMode("original");
  });
}

function buildPageList() {
  elements.pageList.innerHTML = Array.from({ length: state.pdf.numPages }, (_, index) => {
    const number = index + 1;
    return `<button type="button" data-go-page="${number}"><span>${number}</span><div><strong>Trang ${number}</strong><small>Đang dàn chữ…</small></div></button>`;
  }).join("");
  $$('[data-go-page]').forEach((button) => button.addEventListener("click", () => goToPage(Number(button.dataset.goPage))));
}

function updatePageListItem(number, pageData) {
  const small = $(`[data-go-page="${number}"] small`);
  if (small) small.textContent = pageData.text ? `${pageData.text.slice(0, 42)}${pageData.text.length > 42 ? "…" : ""}` : "Chỉ có hình ảnh";
}

function goToPage(number) {
  if (!state.pdf) return;
  state.page = Math.max(1, Math.min(number, state.pdf.numPages));
  if (state.mode === "original") renderOriginalPage();
  else $(`#text-page-${state.page}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  elements.sidebar.classList.remove("open");
  updateNavigation();
}

async function renderOriginalPage() {
  if (!state.pdf) return;
  if (state.renderTask) state.renderTask.cancel();
  const page = await state.pdf.getPage(state.page);
  const baseViewport = page.getViewport({ scale: 1 });
  const availableWidth = Math.min(window.innerWidth - 24, 980);
  const outputScale = Math.min(window.devicePixelRatio || 1, 2);
  const scale = Math.max(0.5, availableWidth / baseViewport.width);
  const viewport = page.getViewport({ scale });
  elements.canvas.width = Math.floor(viewport.width * outputScale);
  elements.canvas.height = Math.floor(viewport.height * outputScale);
  elements.canvas.style.width = `${Math.floor(viewport.width)}px`;
  elements.canvas.style.height = `${Math.floor(viewport.height)}px`;
  const context = elements.canvas.getContext("2d");
  const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;
  state.renderTask = page.render({ canvasContext: context, transform, viewport });
  try { await state.renderTask.promise; } catch (error) { if (error?.name !== "RenderingCancelledException") console.error(error); }
  updateNavigation();
}

function setMode(mode) {
  state.mode = mode;
  const original = mode === "original";
  elements.reflow.classList.toggle("hidden", original);
  elements.canvasWrap.classList.toggle("hidden", !original);
  $("#reflowButton").classList.toggle("active", !original);
  $("#originalButton").classList.toggle("active", original);
  if (original) renderOriginalPage();
  else goToPage(state.page);
}

function updateNavigation() {
  if (!state.pdf) return;
  elements.navStatus.textContent = `${state.page} / ${state.pdf.numPages}`;
  $("#prevPage").disabled = state.page <= 1;
  $("#nextPage").disabled = state.page >= state.pdf.numPages;
  $$('[data-go-page]').forEach((button) => button.classList.toggle("active", Number(button.dataset.goPage) === state.page));
  scheduleBookProgressSave();
}

function chooseFile() {
  elements.fileInput.value = "";
  elements.fileInput.click();
}

function runSearch(query) {
  const term = query.trim().toLocaleLowerCase("vi");
  if (term.length < 2) {
    elements.searchResults.innerHTML = `<p class="search-hint">Nhập ít nhất 2 ký tự để tìm trong nội dung.</p>`;
    return;
  }
  const matches = state.pages.filter((page) => page.text.toLocaleLowerCase("vi").includes(term)).slice(0, 50);
  if (!matches.length) {
    elements.searchResults.innerHTML = `<p class="search-hint">Không tìm thấy “${escapeHtml(query)}”.</p>`;
    return;
  }
  elements.searchResults.innerHTML = matches.map((page) => {
    const index = page.text.toLocaleLowerCase("vi").indexOf(term);
    const start = Math.max(0, index - 45);
    const excerpt = escapeHtml(page.text.slice(start, index)) + `<mark>${escapeHtml(page.text.slice(index, index + term.length))}</mark>` + escapeHtml(page.text.slice(index + term.length, index + term.length + 80));
    return `<button type="button" data-search-page="${page.number}"><strong>Trang ${page.number}</strong><span>${start ? "…" : ""}${excerpt}…</span></button>`;
  }).join("");
  $$('[data-search-page]').forEach((button) => button.addEventListener("click", () => {
    elements.searchSheet.classList.add("hidden");
    goToPage(Number(button.dataset.searchPage));
  }));
}

function sentenceAroundSelection(element, word) {
  const text = element?.textContent?.replace(/\s+/g, " ").trim() || "";
  if (!text) return "";
  const at = text.toLocaleLowerCase("en").indexOf(word.toLocaleLowerCase("en"));
  if (at < 0) return text.slice(0, 2000);
  const boundaries = [text.lastIndexOf(".", at), text.lastIndexOf("!", at), text.lastIndexOf("?", at)];
  const start = Math.max(...boundaries) + 1;
  const endings = [text.indexOf(".", at + word.length), text.indexOf("!", at + word.length), text.indexOf("?", at + word.length)].filter((value) => value >= 0);
  const end = endings.length ? Math.min(...endings) + 1 : text.length;
  return text.slice(start, end).trim().slice(0, 2000);
}

function captureTextSelection() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const commonNode = range.commonAncestorContainer;
  const commonElement = commonNode.nodeType === Node.ELEMENT_NODE ? commonNode : commonNode.parentElement;
  const pageElement = commonElement?.closest?.(".text-page");
  if (!pageElement || !elements.reflow.contains(pageElement)) return null;

  const word = selection.toString().replace(/\s+/g, " ").trim()
    .replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{N}]+$/u, "").slice(0, 200);
  if (!word) return null;
  const textElement = commonElement.closest?.("p, h2") || pageElement;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;

  return {
    word,
    sentence: sentenceAroundSelection(textElement, word),
    page: Number(pageElement.dataset.page) || state.page,
    rect,
  };
}

function hideSelectionTools() {
  elements.selectionAction.classList.add("hidden");
  elements.selectionMenu.classList.add("hidden");
}

function showMobileSelectionAction() {
  if (!window.matchMedia("(hover: none), (pointer: coarse)").matches || state.mode !== "reflow") return;
  const captured = captureTextSelection();
  if (!captured) {
    elements.selectionAction.classList.add("hidden");
    return;
  }
  vocaState.selection = captured;
  const x = Math.max(78, Math.min(window.innerWidth - 78, captured.rect.left + captured.rect.width / 2));
  const y = captured.rect.top > 64 ? captured.rect.top - 9 : captured.rect.bottom + 52;
  elements.selectionAction.style.left = `${x}px`;
  elements.selectionAction.style.top = `${y}px`;
  elements.selectionAction.classList.remove("hidden");
}

function setVocaConnected(connected) {
  $("#vocaButton").classList.toggle("connected", connected);
  $("#vocaButton").setAttribute("aria-label", connected ? "Voca đã kết nối" : "Kết nối Voca");
}

function setFormMessage(element, message = "", success = false) {
  element.textContent = message;
  element.classList.toggle("success", success);
}

function populateCollections(items) {
  vocaState.collections = Array.isArray(items) ? items : [];
  [elements.vocaCollection, elements.vocaDefaultCollection].forEach((select) => {
    const current = vocaState.collectionId;
    select.innerHTML = "";
    const defaultOption = document.createElement("option");
    defaultOption.value = "";
    defaultOption.textContent = "Bộ mặc định / Hộp thư từ mới";
    select.append(defaultOption);
    vocaState.collections.forEach((collection) => {
      const option = document.createElement("option");
      option.value = collection.id;
      option.textContent = `${collection.parent_id ? "↳ " : ""}${collection.name}${collection.is_inbox ? " · Inbox" : ""}`;
      select.append(option);
    });
    select.value = [...select.options].some((option) => option.value === current) ? current : "";
  });
}

async function vocaRequest(path, options = {}) {
  let response;
  try {
    response = await fetch(`${VOCA_API}${path}`, {
      ...options,
      headers: { "X-API-Key": vocaState.apiKey, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
    });
  } catch {
    throw new Error("Không thể kết nối Voca. Hãy kiểm tra mạng và thử lại.");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Voca trả về lỗi ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function loadVocaCollections() {
  const data = await vocaRequest("/external/collections");
  populateCollections(data.items);
  return data.items;
}

function showVocaConnect(message = "") {
  elements.vocaConnect.classList.remove("hidden");
  elements.vocaSaveForm.classList.add("hidden");
  elements.vocaReady.classList.add("hidden");
  elements.vocaApiKey.value = "";
  setFormMessage(elements.vocaConnectMessage, message);
  $("#vocaSheetTitle").textContent = "Kết nối Voca";
  setTimeout(() => elements.vocaApiKey.focus(), 50);
}

function showVocaSave() {
  const selected = vocaState.selection;
  if (!selected) return;
  elements.vocaConnect.classList.add("hidden");
  elements.vocaReady.classList.add("hidden");
  elements.vocaSaveForm.classList.remove("hidden");
  elements.vocaWord.value = selected.word;
  elements.vocaCollection.value = vocaState.collectionId;
  elements.vocaContext.textContent = selected.sentence
    ? `“${selected.sentence}” · Trang ${selected.page}`
    : `Ngữ cảnh từ trang ${selected.page}`;
  setFormMessage(elements.vocaSaveMessage);
  $("#vocaSheetTitle").textContent = "Lưu từ mới";
}

function showVocaReady() {
  elements.vocaConnect.classList.add("hidden");
  elements.vocaSaveForm.classList.add("hidden");
  elements.vocaReady.classList.remove("hidden");
  elements.vocaDefaultCollection.value = vocaState.collectionId;
  $("#vocaSheetTitle").textContent = "Kết nối Voca";
}

async function openVocaSheet(withSelection = false) {
  hideSelectionTools();
  elements.vocaSheet.classList.remove("hidden");
  if (!vocaState.apiKey) {
    showVocaConnect();
    return;
  }
  setVocaConnected(true);
  if (withSelection) showVocaSave(); else showVocaReady();
  if (!vocaState.collections.length) {
    try {
      await loadVocaCollections();
      if (withSelection) showVocaSave(); else showVocaReady();
    } catch (error) {
      if (error.status === 401 || error.status === 403) {
        setVocaConnected(false);
        showVocaConnect("API key không còn hợp lệ. Vui lòng nhập key mới.");
      } else {
        if (withSelection) setFormMessage(elements.vocaSaveMessage, error.message);
        else showToast(error.message);
      }
    }
  }
}

async function connectVoca() {
  const key = elements.vocaApiKey.value.trim();
  if (!key) {
    setFormMessage(elements.vocaConnectMessage, "Hãy nhập API key từ Voca.");
    return;
  }
  const button = $("#connectVoca");
  button.disabled = true;
  button.textContent = "Đang kết nối…";
  setFormMessage(elements.vocaConnectMessage);
  vocaState.apiKey = key;
  try {
    await loadVocaCollections();
    if (vocaKeyForUser()) storage.set(vocaKeyForUser(), key);
    setVocaConnected(true);
    if (vocaState.selection) showVocaSave(); else showVocaReady();
  } catch (error) {
    vocaState.apiKey = "";
    setVocaConnected(false);
    setFormMessage(elements.vocaConnectMessage, error.status === 401 ? "API key không hợp lệ hoặc đã bị thu hồi." : error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Kết nối";
  }
}

async function saveSelectionToVoca() {
  const word = elements.vocaWord.value.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!word) {
    setFormMessage(elements.vocaSaveMessage, "Từ cần lưu không được để trống.");
    return;
  }
  const button = $("#saveToVoca");
  button.disabled = true;
  button.textContent = "Đang lưu…";
  setFormMessage(elements.vocaSaveMessage);
  const selected = vocaState.selection;
  const collectionId = elements.vocaCollection.value;
  const body = {
    word,
    language: "en",
    source: "trang_giay_pdf_reader",
    context: {
      sentence: selected?.sentence || undefined,
      source_title: elements.fileName.textContent || "PDF",
      source_type: "book",
      location: `Trang ${selected?.page || state.page}`,
    },
    ...(collectionId ? { collection_id: collectionId } : {}),
  };
  try {
    const result = await vocaRequest("/external/vocabulary", { method: "POST", body: JSON.stringify(body) });
    vocaState.collectionId = collectionId;
    scheduleSettingsSync();
    const messages = { created: "Đã lưu từ mới vào Voca.", updated: "Đã bổ sung ngữ cảnh vào từ này.", unchanged: "Từ này đã có trong Voca." };
    const message = messages[result.status] || "Đã lưu vào Voca.";
    setFormMessage(elements.vocaSaveMessage, message, true);
    showToast(`${word}: ${message}`);
    window.getSelection()?.removeAllRanges();
    setTimeout(() => elements.vocaSheet.classList.add("hidden"), 850);
  } catch (error) {
    if (error.status === 401 || error.status === 403) setVocaConnected(false);
    setFormMessage(elements.vocaSaveMessage, error.status === 401 ? "API key không hợp lệ hoặc đã bị thu hồi." : error.message);
  } finally {
    button.disabled = false;
    button.textContent = "Lưu từ này";
  }
}

function returnHome() {
  if (!state.pdf || confirm("Đóng tài liệu hiện tại và quay về trang đầu?")) {
    clearTimeout(scheduleBookProgressSave.timer);
    updateCurrentBookProgress();
    state.pdf?.destroy();
    state.pdf = null;
    state.pages = [];
    elements.reader.classList.add("hidden");
    elements.welcome.classList.remove("hidden");
    elements.sidebar.classList.remove("open");
    renderLibrary();
    return true;
  }
  return false;
}

applyPreferences();
setVocaConnected(Boolean(vocaState.apiKey));

elements.fileInput.addEventListener("change", (event) => openPdf(event.target.files[0]));
$("#loginTab").addEventListener("click", () => setAuthMode("login"));
$("#registerTab").addEventListener("click", () => setAuthMode("register"));
elements.authForm.addEventListener("submit", submitAuth);
elements.userButton.addEventListener("click", () => {
  elements.userMenu.classList.toggle("hidden");
  elements.userButton.setAttribute("aria-expanded", String(!elements.userMenu.classList.contains("hidden")));
});
$("#logoutButton").addEventListener("click", logoutAccount);
$("#showLibrary").addEventListener("click", () => {
  elements.userMenu.classList.add("hidden");
  if (returnHome()) $("#localLibrary").scrollIntoView({ behavior: "smooth", block: "start" });
});
[$("#openTopButton"), $("#openHeroButton")].forEach((label) => label.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    chooseFile();
  }
}));
$("#homeButton").addEventListener("click", returnHome);
$("#themeButton").addEventListener("click", () => setTheme({ sepia: "dark", dark: "light", light: "sepia" }[state.theme]));
$("#settingsButton").addEventListener("click", () => {
  elements.settings.classList.toggle("hidden");
  $("#settingsButton").setAttribute("aria-expanded", String(!elements.settings.classList.contains("hidden")));
});
$("#fontDown").addEventListener("click", () => { state.fontSize = Math.max(14, state.fontSize - 1); storage.set("reader-font-size", state.fontSize); applyPreferences(); scheduleSettingsSync(); });
$("#fontUp").addEventListener("click", () => { state.fontSize = Math.min(34, state.fontSize + 1); storage.set("reader-font-size", state.fontSize); applyPreferences(); scheduleSettingsSync(); });
elements.lineHeight.addEventListener("input", (event) => { state.lineHeight = Number(event.target.value); storage.set("reader-line-height", state.lineHeight); applyPreferences(); scheduleSettingsSync(); });
$$('[data-set-theme]').forEach((button) => button.addEventListener("click", () => setTheme(button.dataset.setTheme)));
$("#reflowButton").addEventListener("click", () => setMode("reflow"));
$("#originalButton").addEventListener("click", () => setMode("original"));
$("#prevPage").addEventListener("click", () => goToPage(state.page - 1));
$("#nextPage").addEventListener("click", () => goToPage(state.page + 1));
$("#menuButton").addEventListener("click", () => elements.sidebar.classList.add("open"));
$("#closeSidebar").addEventListener("click", () => elements.sidebar.classList.remove("open"));
$("#searchButton").addEventListener("click", () => { elements.searchSheet.classList.remove("hidden"); elements.searchInput.focus(); runSearch(elements.searchInput.value); });
$("#closeSearch").addEventListener("click", () => elements.searchSheet.classList.add("hidden"));
elements.searchInput.addEventListener("input", (event) => runSearch(event.target.value));
elements.searchSheet.addEventListener("click", (event) => { if (event.target === elements.searchSheet) elements.searchSheet.classList.add("hidden"); });

$("#vocaButton").addEventListener("click", () => {
  vocaState.selection = null;
  openVocaSheet(false);
});
$("#closeVoca").addEventListener("click", () => elements.vocaSheet.classList.add("hidden"));
elements.vocaSheet.addEventListener("click", (event) => { if (event.target === elements.vocaSheet) elements.vocaSheet.classList.add("hidden"); });
$("#connectVoca").addEventListener("click", connectVoca);
elements.vocaApiKey.addEventListener("keydown", (event) => { if (event.key === "Enter") connectVoca(); });
$("#saveToVoca").addEventListener("click", saveSelectionToVoca);
$("#changeVocaKey").addEventListener("click", () => showVocaConnect());
[elements.vocaCollection, elements.vocaDefaultCollection].forEach((select) => select.addEventListener("change", (event) => {
  vocaState.collectionId = event.target.value;
  elements.vocaCollection.value = vocaState.collectionId;
  elements.vocaDefaultCollection.value = vocaState.collectionId;
  scheduleSettingsSync();
}));

elements.reflow.addEventListener("contextmenu", (event) => {
  const captured = captureTextSelection();
  if (!captured) return;
  event.preventDefault();
  vocaState.selection = captured;
  $("#selectionMenuWord").textContent = `“${captured.word}”`;
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - 233));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - 105));
  elements.selectionMenu.style.left = `${left}px`;
  elements.selectionMenu.style.top = `${top}px`;
  elements.selectionMenu.classList.remove("hidden");
  elements.selectionAction.classList.add("hidden");
});

$("#contextSaveButton").addEventListener("click", () => openVocaSheet(true));
$("#selectionSaveButton").addEventListener("pointerdown", (event) => event.preventDefault());
$("#selectionSaveButton").addEventListener("click", () => openVocaSheet(true));
document.addEventListener("pointerdown", (event) => {
  if (!elements.selectionMenu.contains(event.target)) elements.selectionMenu.classList.add("hidden");
  if (!elements.userMenu.contains(event.target) && !elements.userButton.contains(event.target)) elements.userMenu.classList.add("hidden");
});
document.addEventListener("selectionchange", () => {
  clearTimeout(showMobileSelectionAction.timer);
  if (!elements.vocaSheet.classList.contains("hidden")) return;
  showMobileSelectionAction.timer = setTimeout(showMobileSelectionAction, 220);
});
window.addEventListener("scroll", () => elements.selectionAction.classList.add("hidden"), { passive: true });

window.addEventListener("resize", () => { if (state.mode === "original" && state.pdf) renderOriginalPage(); });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { elements.searchSheet.classList.add("hidden"); elements.vocaSheet.classList.add("hidden"); hideSelectionTools(); elements.settings.classList.add("hidden"); elements.sidebar.classList.remove("open"); }
  if (state.pdf && !elements.searchSheet.classList.contains("hidden")) return;
  if (state.pdf && event.key === "ArrowLeft") goToPage(state.page - 1);
  if (state.pdf && event.key === "ArrowRight") goToPage(state.page + 1);
});

let dragCounter = 0;
window.addEventListener("dragenter", (event) => { event.preventDefault(); dragCounter += 1; elements.dropZone.classList.remove("hidden"); });
window.addEventListener("dragleave", () => { dragCounter -= 1; if (dragCounter <= 0) elements.dropZone.classList.add("hidden"); });
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("drop", (event) => { event.preventDefault(); dragCounter = 0; elements.dropZone.classList.add("hidden"); openPdf(event.dataTransfer.files[0]); });

const observer = new IntersectionObserver((entries) => {
  const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
  if (visible && state.mode === "reflow") { state.page = Number(visible.target.dataset.page); updateNavigation(); }
}, { rootMargin: "-25% 0px -60%", threshold: [0, 0.25, 0.75] });

const contentObserver = new MutationObserver(() => $$('.text-page').forEach((page) => observer.observe(page)));
contentObserver.observe(elements.reflow, { childList: true });
initializeAuth();
