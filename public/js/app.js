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
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.remove("hidden");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.add("hidden"), 2800);
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

async function openPdf(file) {
  if (!file || (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf"))) {
    showToast("Vui lòng chọn một file PDF.");
    return;
  }

  if (state.pdf) await state.pdf.destroy();
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
    updateNavigation();
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

function returnHome() {
  if (!state.pdf || confirm("Đóng tài liệu hiện tại và quay về trang đầu?")) {
    state.pdf?.destroy();
    state.pdf = null;
    state.pages = [];
    elements.reader.classList.add("hidden");
    elements.welcome.classList.remove("hidden");
    elements.sidebar.classList.remove("open");
  }
}

applyPreferences();

elements.fileInput.addEventListener("change", (event) => openPdf(event.target.files[0]));
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
$("#fontDown").addEventListener("click", () => { state.fontSize = Math.max(14, state.fontSize - 1); storage.set("reader-font-size", state.fontSize); applyPreferences(); });
$("#fontUp").addEventListener("click", () => { state.fontSize = Math.min(34, state.fontSize + 1); storage.set("reader-font-size", state.fontSize); applyPreferences(); });
elements.lineHeight.addEventListener("input", (event) => { state.lineHeight = Number(event.target.value); storage.set("reader-line-height", state.lineHeight); applyPreferences(); });
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

window.addEventListener("resize", () => { if (state.mode === "original" && state.pdf) renderOriginalPage(); });
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { elements.searchSheet.classList.add("hidden"); elements.settings.classList.add("hidden"); elements.sidebar.classList.remove("open"); }
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
