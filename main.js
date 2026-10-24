'use strict';

const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, Notice, TFile, Modal, normalizePath } = obsidian;

const PLUGIN_ID = 'attachment-router';
const EXT_CACHE = new Map();
// 素材目录文件数达到这个量级时，改名前后各给一次提示
const MANY_FILES_THRESHOLD = 20;

// 目录段格式：<笔记名>笔记素材-YYYYMMDD-HHmmss-mmm。
// 早期版本用「笔记附件-」，这里一并认，免得旧目录失联。
const NOTE_FOLDER_RE = /^(.*)笔记(素材|附件)-(\d{8}-\d{6}-\d{3})$/;
// 术语迁移前的默认值：旧「附件」总目录名、旧「其他」分类目录名
const LEGACY_ATTACH_ROOT = '所有笔记附件合集';
const LEGACY_FOLDER_OTHER = '附件';

const DEFAULT_SETTINGS = {
  enabled: true,
  attachRoot: '所有笔记素材合集',
  folderImage: '图片',
  folderGif: '动图',
  folderVideo: '视频',
  folderOther: '素材',
  extImage: 'png,jpg,jpeg,webp,bmp,tga,tif,tiff,avif,svg',
  extGif: 'gif,apng',
  extVideo: 'mp4,mov,webm,avi,mkv,m4v,wmv,flv',
  delayMs: 2500,
  onlyRootOrNoteFolder: true,
  // 定时自动清理：每 N 天扫一次素材总目录，把没人引用的文件移入回收站；0 = 关闭
  autoCleanDays: 7,
  lastAutoClean: 0,
  // 只对“启用之后新建的笔记”负责，首次加载时写入，之后不再变。
  enabledAt: 0,
  // 内部缓存：笔记路径 → 素材目录段（不含总目录）。笔记改名时迁移键。
  noteFolders: {},
  // 配置结构版本，用来保证旧配置只迁移一次（3 = 「附件」改叫「素材」）
  schema: 3,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateAt(fmt, timestamp) {
  const d = new Date(Number(timestamp) || Date.now());
  const map = {
    YYYY: String(d.getFullYear()),
    YY: String(d.getFullYear()).slice(-2),
    MM: pad2(d.getMonth() + 1),
    DD: pad2(d.getDate()),
    HH: pad2(d.getHours()),
    mm: pad2(d.getMinutes()),
    ss: pad2(d.getSeconds()),
  };
  return fmt.replace(/YYYY|YY|MM|DD|HH|mm|ss/g, (m) => (map[m] !== undefined ? map[m] : m));
}

function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext: name.slice(i + 1) };
}

// Windows 不允许这几个名字（含带扩展名的形式）
const RESERVED_WIN_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function sanitize(name) {
  let out = String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|#^\[\]]/g, '_')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .replace(/[. ]+$/, '');
  if (RESERVED_WIN_NAME.test(out)) out = '_' + out;
  return out;
}

// 把一段相对路径逐段 sanitize，和笔记路径做「镜像对照」时两边都走这个函数
function sanitizePath(relPath) {
  return String(relPath == null ? '' : relPath)
    .split('/')
    .filter((p) => p && p !== '.')
    .map(sanitize)
    .join('/');
}

function parentOfPath(path) {
  const slash = String(path).lastIndexOf('/');
  return slash > 0 ? String(path).slice(0, slash) : '';
}

// 删除事件里的路径可能已经带 .trash/ 前缀（Obsidian 先把文件移入回收站再发事件），
// 比较和缓存都要用去掉前缀后的路径。
function stripTrashPath(path) {
  return String(path == null ? '' : path).replace(/^\.trash\//, '');
}

// 右上角轻提示：Obsidian 的 Notice 固定在右下角，这里自己画一个；没有 DOM 时退回 Notice
function showToast(message, duration = 4000) {
  if (typeof document === 'undefined' || !document.body) {
    new Notice(message, duration);
    return;
  }
  try {
    let host = document.getElementById('attachment-router-toast-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'attachment-router-toast-host';
      host.style.cssText =
        'position:fixed;top:16px;right:16px;z-index:9999;display:flex;flex-direction:column;gap:8px;pointer-events:none;max-width:360px;';
      document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.textContent = message;
    el.style.cssText =
      'padding:8px 12px;border-radius:8px;font-size:12px;line-height:1.4;background:var(--background-secondary,#2a2a2a);color:var(--text-normal,#ddd);box-shadow:0 2px 8px rgba(0,0,0,0.25);opacity:0;transition:opacity .2s ease;';
    host.appendChild(el);
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        el.style.opacity = '1';
      });
    } else {
      el.style.opacity = '1';
    }
    setTimeout(() => {
      el.style.opacity = '0';
      setTimeout(() => {
        el.remove();
        if (host.children.length === 0) host.remove();
      }, 250);
    }, duration);
  } catch (e) {
    new Notice(message, duration);
  }
}

class AttachmentRouter extends Plugin {
  async onload() {
    await this.loadSettings();
    let dirty = this.pruneNoteFolders();
    if (this.rebuildNoteFolders()) dirty = true;
    if (dirty) await this.saveSettings();

    this.busy = new Set();
    this.lastNote = null;
    this.moveQueue = Promise.resolve();
    this.unloaded = false;
    this.autoCleanTimer = null;
    this.idleHandle = null;
    this.idleUsesRic = false;

    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (file instanceof TFile && file.extension === 'md') this.lastNote = file;
      })
    );

    this.registerEvent(
      this.app.vault.on('create', (file) => {
        this.handleCreate(file);
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        this.onNoteRenamed(file, oldPath).catch((e) => {
          console.error('[' + PLUGIN_ID + '] rename handler failed:', e);
        });
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        this.onNoteDeleted(file).catch((e) => {
          console.error('[' + PLUGIN_ID + '] delete handler failed:', e);
        });
      })
    );

    // 笔记右键菜单和左侧栏都放入口，免得只靠命令面板找不到
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem((item) =>
          item
            .setTitle('清理未引用素材')
            .setIcon('trash')
            .onClick(() => this.cleanUnusedAttachmentsFor(file))
        );
      })
    );
    this.registerEvent(
      this.app.workspace.on('files-menu', (menu, files) => {
        const notes = (files || []).filter((f) => f instanceof TFile && f.extension === 'md');
        if (notes.length < 2) return;
        menu.addItem((item) =>
          item
            .setTitle(`清理未引用素材（${notes.length} 篇）`)
            .setIcon('trash')
            .onClick(() => this.cleanUnusedAttachmentsFor(notes))
        );
      })
    );
    this.addRibbonIcon('trash', '清理当前笔记的未引用素材', () => this.cleanUnusedAttachments());

    this.addSettingTab(new RouterSettingTab(this.app, this));

    this.addCommand({
      id: 'show-rules',
      name: '查看当前归位规则',
      callback: () => {
        const s = this.settings;
        const root = sanitize(s.attachRoot) || '所有笔记素材合集';
        new Notice(
          `根目录 -> ${root}/笔记所在文件夹/笔记名笔记素材-时间戳/类型/\n图片 -> ${s.folderImage}\n动图 -> ${s.folderGif}\n视频 -> ${s.folderVideo}\n其他 -> ${s.folderOther}\n命名 -> 保留原文件名（同名同后缀自动加 _1、_2；时间戳只用在目录名上）\n生效 -> ${formatDateAt('YYYY-MM-DD HH:mm:ss', s.enabledAt)} 之后新建的笔记`,
          8000
        );
      },
    });

    this.addCommand({
      id: 'clean-unused-attachments',
      name: '清理当前笔记的未引用素材',
      callback: () => this.cleanUnusedAttachments(),
    });

    this.maybeScheduleAutoClean();
  }

  onunload() {
    this.unloaded = true;
    // 还在排队的那次保存别丢：禁用/关闭 Obsidian 时立刻落盘一次
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveData(Object.assign({}, this.settings)).catch(() => {});
    }
    if (this.autoCleanTimer) {
      clearTimeout(this.autoCleanTimer);
      this.autoCleanTimer = null;
    }
    if (this.idleHandle) {
      if (this.idleUsesRic && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
        window.cancelIdleCallback(this.idleHandle);
      } else {
        clearTimeout(this.idleHandle);
      }
      this.idleHandle = null;
    }
    this.busy.clear();
  }

  async loadSettings() {
    const saved = await this.loadData();
    const raw = saved || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    let dirty = false;

    // 1.2 以前的默认值叫「笔记附件」，只在没有 schema 标记时迁移一次；
    // 迁移之后用户再把根目录名改回旧名字也会被尊重。
    if (raw.attachRoot === '笔记附件' && raw.schema === undefined) {
      this.settings.attachRoot = DEFAULT_SETTINGS.attachRoot;
      dirty = true;
    }

    // 术语从「附件」改成「素材」。旧目录里已经有文件时保持旧名字不动，
    // 否则既有素材会留在旧目录、插件却跑到新目录里找。schema 3 之后不再检查。
    if (raw.schema === undefined || Number(raw.schema) < 3) {
      if (this.settings.attachRoot === LEGACY_ATTACH_ROOT && !this.hasFilesUnder(LEGACY_ATTACH_ROOT)) {
        this.settings.attachRoot = DEFAULT_SETTINGS.attachRoot;
        dirty = true;
      }
      if (this.settings.folderOther === LEGACY_FOLDER_OTHER) {
        if (!this.legacyCategoryInUse(this.settings.attachRoot, LEGACY_FOLDER_OTHER)) {
          this.settings.folderOther = DEFAULT_SETTINGS.folderOther;
          dirty = true;
        }
      }
    }

    // 钉住启用时间：只有这之后新建的笔记才归插件管，旧笔记一律不动。
    if (!this.settings.enabledAt) {
      this.settings.enabledAt = Date.now();
      dirty = true;
    }

    if (this.settings.schema !== DEFAULT_SETTINGS.schema) {
      this.settings.schema = DEFAULT_SETTINGS.schema;
      dirty = true;
    }

    // 内部缓存不能和默认值共用同一个对象
    this.settings.noteFolders = Object.assign({}, this.settings.noteFolders || {});

    if (dirty) await this.saveSettings();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // 输入设置时防抖落盘，别每敲一个字符写一次 data.json
  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveSettings().catch(() => {});
    }, 400);
  }

  // 加载时清掉已不存在笔记的目录缓存，避免 data.json 只涨不消
  pruneNoteFolders() {
    const map = this.settings.noteFolders;
    if (!map || !this.app || !this.app.vault) return false;
    let changed = false;
    for (const key of Object.keys(map)) {
      if (!(this.app.vault.getAbstractFileByPath(key) instanceof TFile)) {
        delete map[key];
        changed = true;
      }
    }
    return changed;
  }

  // 加载时按目录名把笔记和素材目录重新对上，缓存被清空也能自愈
  rebuildNoteFolders() {
    const map = this.settings.noteFolders;
    if (!map) return false;
    let root;
    try {
      root = this.attachmentRootPath();
    } catch (e) {
      return false;
    }
    const segments = this.scanSegments(root);
    if (!segments.length) return false;
    const byKey = new Map();
    const byBase = new Map();
    for (const n of this.app.vault.getMarkdownFiles()) {
      byKey.set(sanitizePath(n.path), n);
      const base = sanitize(n.basename);
      if (!byBase.has(base)) byBase.set(base, []);
      byBase.get(base).push(n);
    }
    let changed = false;
    for (const seg of segments) {
      // 镜像路径能反推出笔记路径时优先精确匹配
      let note = byKey.get(seg.noteKey);
      if (!note) {
        // 旧版扁平目录 / 笔记被手动挪过：只有同名笔记唯一时才认领
        const candidates = byBase.get(seg.name) || [];
        if (candidates.length === 1) note = candidates[0];
      }
      if (!note || map[note.path]) continue;
      map[note.path] = seg.rel;
      changed = true;
    }
    return changed;
  }

  parseExts(str) {
    const key = String(str || '');
    const cached = EXT_CACHE.get(key);
    if (cached) return cached;
    const list = key
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
      .filter(Boolean);
    EXT_CACHE.set(key, list);
    return list;
  }

  kindOf(ext) {
    const s = this.settings;
    if (this.parseExts(s.extGif).includes(ext)) return 'gif';
    if (this.parseExts(s.extVideo).includes(ext)) return 'video';
    if (this.parseExts(s.extImage).includes(ext)) return 'image';
    return 'other';
  }

  subFolderFor(kind) {
    const s = this.settings;
    if (kind === 'image') return sanitize(s.folderImage);
    if (kind === 'gif') return sanitize(s.folderGif);
    if (kind === 'video') return sanitize(s.folderVideo);
    return sanitize(s.folderOther);
  }

  async ensureFolder(path) {
    if (!path) return;
    const parts = normalizePath(path).split('/');
    let cur = '';
    for (const p of parts) {
      cur = cur ? cur + '/' + p : p;
      if (!this.app.vault.getAbstractFileByPath(cur)) {
        try {
          await this.app.vault.createFolder(cur);
        } catch (e) {
          // 已存在或并发创建，忽略
        }
      }
    }
  }

  // 笔记所在文件夹（相对库根）→ 素材总目录里的镜像前缀；根目录笔记返回 ''
  mirrorParentForPath(notePath) {
    return sanitizePath(parentOfPath(notePath));
  }

  mirrorParentForNote(note) {
    const parent = note && note.parent && note.parent.path && note.parent.path !== '/' ? note.parent.path : '';
    return sanitizePath(parent);
  }

  // 新建素材目录时用的段名：<笔记名>笔记素材-创建时间戳
  makeSegmentName(note, kind = '素材') {
    const ctime = Number(note.stat && note.stat.ctime) || Date.now();
    const stamp = formatDateAt('YYYYMMDD-HHmmss', ctime) + '-' + String(ctime % 1000).padStart(3, '0');
    return sanitize(note.basename) + '笔记' + kind + '-' + stamp;
  }

  expectedSegmentRel(note) {
    const parent = this.mirrorParentForNote(note);
    const segment = this.makeSegmentName(note);
    return parent ? parent + '/' + segment : segment;
  }

  // 扫素材总目录：找出所有「段」（最后一段匹配 笔记素材-时间戳），带上镜像前缀
  scanSegments(root) {
    const out = new Map();
    const prefix = root + '/';
    try {
      for (const f of this.app.vault.getFiles()) {
        if (f.path.indexOf(prefix) !== 0) continue;
        const parts = f.path.slice(prefix.length).split('/');
        for (let i = parts.length - 2; i >= 0; i--) {
          const m = NOTE_FOLDER_RE.exec(parts[i]);
          if (!m) continue;
          const rel = parts.slice(0, i + 1).join('/');
          if (out.has(rel)) break;
          const prefixRel = parts.slice(0, i).join('/');
          out.set(rel, {
            rel,
            prefix: prefixRel,
            name: m[1],
            kind: m[2],
            stamp: m[3],
            noteKey: (prefixRel ? prefixRel + '/' : '') + m[1] + '.md',
          });
          break;
        }
      }
    } catch (e) {
      return [];
    }
    return [...out.values()];
  }

  // 缓存丢了：按「镜像路径 → 笔记路径」精确找回；再退回同名唯一候选（兼容旧扁平目录）
  findSegmentRelForNote(note, root) {
    const segments = this.scanSegments(root);
    const noteKey = sanitizePath(stripTrashPath(note.path));
    const exact = segments.filter((s) => s.noteKey === noteKey);
    if (exact.length === 1) return exact[0].rel;
    if (exact.length > 1) return null; // 有歧义就不猜
    const base = sanitize(note.basename);
    const sameName = segments.filter((s) => s.name === base);
    return sameName.length === 1 ? sameName[0].rel : null;
  }

  relPathOf(folderPath, root) {
    const prefix = root + '/';
    return folderPath.indexOf(prefix) === 0 ? folderPath.slice(prefix.length) : null;
  }

  // 素材目录段优先用缓存；缓存丢了按镜像路径找回；都没有就用笔记创建时间生成一个新段
  noteAttachmentFolder(note, root) {
    const cache = this.settings.noteFolders || (this.settings.noteFolders = {});
    const cached = cache[note.path];
    if (cached && cached.indexOf('..') === -1) {
      const path = normalizePath([root, cached].filter(Boolean).join('/'));
      if (this.app.vault.getAbstractFileByPath(path)) return path;
    }
    const found = this.findSegmentRelForNote(note, root);
    if (found) {
      cache[note.path] = found;
      this.saveSettings().catch(() => {});
      return normalizePath(root + '/' + found);
    }
    const rel = this.expectedSegmentRel(note);
    cache[note.path] = rel;
    this.saveSettings().catch(() => {});
    return normalizePath(root + '/' + rel);
  }

  // 给一篇笔记找它现有的素材目录（缓存优先，其次按镜像路径 / 同名唯一）
  attachmentFolderFor(note) {
    let root;
    try {
      root = this.attachmentRootPath();
    } catch (e) {
      return null;
    }
    const map = this.settings.noteFolders || {};
    const notePath = stripTrashPath(note.path);
    const cached = map[note.path] !== undefined ? map[note.path] : map[notePath];
    if (cached && cached.indexOf('..') === -1) {
      const path = normalizePath([root, cached].filter(Boolean).join('/'));
      if (this.app.vault.getAbstractFileByPath(path)) return path;
    }
    const found = this.findSegmentRelForNote(note, root);
    if (found) {
      map[notePath] = found;
      this.saveSettings().catch(() => {});
      return normalizePath(root + '/' + found);
    }
    return null;
  }

  filesUnder(folderPath) {
    const prefix = folderPath + '/';
    try {
      return this.app.vault.getFiles().filter((f) => f.path.indexOf(prefix) === 0);
    } catch (e) {
      return [];
    }
  }

  // 这个目录下是否已经有文件（迁移前先确认，避免既有素材被留在旧名字下）
  hasFilesUnder(path) {
    try {
      const prefix = normalizePath(path) + '/';
      return this.app.vault.getFiles().some((f) => f.path.indexOf(prefix) === 0);
    } catch (e) {
      return true; // 拿不准就当有，宁可不迁移
    }
  }

  // 总目录下是否还有人在用旧的分类目录名（root/<笔记素材段>/<分类>/…）
  legacyCategoryInUse(root, name) {
    try {
      const prefix = normalizePath(root) + '/';
      return this.app.vault.getFiles().some((f) => {
        if (f.path.indexOf(prefix) !== 0) return false;
        return f.path.slice(prefix.length).split('/')[1] === name;
      });
    } catch (e) {
      return true;
    }
  }

  attachmentRootPath() {
    const root = normalizePath(sanitize(String(this.settings.attachRoot || '')));
    if (!root || root === '.') throw new Error('素材总目录名称不能为空');
    const existing = this.app.vault.getAbstractFileByPath(root);
    if (existing && !(existing.children && Array.isArray(existing.children))) {
      throw new Error(`素材总目录与文件重名：${root}`);
    }
    return root;
  }

  // 目标目录里已有的名字（小写比较），Windows/macOS 上大小写也算撞名
  takenNamesIn(dir) {
    const out = new Set();
    try {
      const folder = dir ? this.app.vault.getAbstractFileByPath(dir) : null;
      const children = folder && Array.isArray(folder.children) ? folder.children : [];
      for (const child of children) out.add(String(child.name || '').toLowerCase());
    } catch (e) {
      // 读不到就当目录是空的，后面还有 getAbstractFileByPath 兜底
    }
    return out;
  }

  // 同名同后缀时按 _1、_2 往上加；默认保留原文件名
  uniquePath(path) {
    const slash = path.lastIndexOf('/');
    const dir = slash >= 0 ? path.slice(0, slash) : '';
    const fileName = slash >= 0 ? path.slice(slash + 1) : path;
    const { base, ext } = splitExt(fileName);
    const taken = this.takenNamesIn(dir);

    const free = (name) => {
      if (taken.has(name.toLowerCase())) return false;
      return !this.app.vault.getAbstractFileByPath(dir ? dir + '/' + name : name);
    };
    const join = (name) => (dir ? dir + '/' + name : name);

    if (free(fileName)) return path;
    for (let n = 1; n < 10000; n++) {
      const candidate = base + '_' + n + (ext ? '.' + ext : '');
      if (free(candidate)) return join(candidate);
    }
    // 极端占满时用一个不依赖时间的递增计数兜底，至少还能落地且不带时间戳
    this.nameFallback = (Number(this.nameFallback) || 0) + 1;
    return join(base + '_' + this.nameFallback + (ext ? '.' + ext : ''));
  }

  expectedSourceDirs(note) {
    const out = new Set(['/', '']);
    const noteDir = note.parent && note.parent.path !== '/' ? note.parent.path : '';
    out.add(noteDir);

    let cfg = '/';
    try {
      cfg = this.app.vault.getConfig('attachmentFolderPath') || '/';
    } catch (e) {
      cfg = '/';
    }
    if (cfg === '/') {
      out.add('/');
    } else if (cfg === './') {
      out.add(noteDir);
    } else if (cfg.indexOf('./') === 0) {
      out.add(normalizePath((noteDir ? noteDir + '/' : '') + cfg.slice(2)));
    } else {
      out.add(normalizePath(cfg));
    }
    return out;
  }

  findViewFor(notePath) {
    let found = null;
    try {
      for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
        const view = leaf && leaf.view;
        if (view && view.file && view.file.path === notePath) found = view;
      }
    } catch (e) {
      return null;
    }
    return found;
  }

  // 正文里的链接可能是原样、URL 编码（%20）或带路径的形态，都要认
  linkForms(file) {
    const out = new Set();
    for (const value of [file.name, file.path]) {
      if (!value) continue;
      out.add(value);
      out.add(encodeURI(value));
      out.add(encodeURIComponent(value));
    }
    return [...out];
  }

  countLinkForms(text, forms) {
    let total = 0;
    for (const form of forms) {
      let at = text.indexOf(form);
      while (at !== -1) {
        total++;
        at = text.indexOf(form, at + form.length);
      }
    }
    return total;
  }

  // metadataCache 已确认这篇笔记引用了该文件（用于“链接先写入”的兜底）
  noteReferences(note, file) {
    try {
      const all = this.app.metadataCache && this.app.metadataCache.resolvedLinks;
      const refs = all && all[note.path];
      return !!(refs && refs[file.path] > 0);
    } catch (e) {
      return false;
    }
  }

  // 当前正文里出现了几次“这个文件”的链接形态，用来做增量判断
  linkOccurrences(note, file) {
    const view = this.findViewFor(note.path);
    if (!view || !view.editor) return 0;
    try {
      return this.countLinkForms(view.editor.getValue(), this.linkForms(file));
    } catch (e) {
      return 0;
    }
  }

  // 等正文里的链接数量比拖入前更多（而不是“包含这个名字”），同名旧链接不会被误判
  async waitForLinkInNote(note, file, timeoutMs, baseline) {
    const forms = this.linkForms(file);
    const budget = Math.max(500, Number(timeoutMs) || 0);
    const deadline = Date.now() + budget;
    const base = Number(baseline) || 0;
    while (Date.now() < deadline) {
      const view = this.findViewFor(note.path);
      if (view && view.editor) {
        try {
          if (this.countLinkForms(view.editor.getValue(), forms) > base) return true;
        } catch (e) {
          // 编辑器尚未就绪
        }
      }
      // 兜底：万一是链接先写进去、create 才触发，计数不会增加，就看索引里有没有
      if (this.noteReferences(note, file)) return true;
      await sleep(80);
    }
    return false;
  }

  // 兜底：改名后正文里若仍残留旧文件名，按词边界逐处替换（含 %20 等编码形态）
  fixStaleLink(note, oldName, newName) {
    if (!oldName || !newName || oldName === newName) return;
    const view = this.findViewFor(note.path);
    if (!view || !view.editor) return;
    // 库里还有同名文件时，链接本身就有歧义：批量替换会把指向别的文件的链接也改掉。
    // 这种情况交给 Obsidian 的「自动更新内部链接」，这里一律不动。
    try {
      const lower = String(oldName).toLowerCase();
      const sameName = this.app.vault.getFiles().some((f) => String(f.name).toLowerCase() === lower);
      if (sameName) return;
    } catch (e) {
      return;
    }
    try {
      const editor = view.editor;
      const text = editor.getValue();
      const variants = [...new Set([oldName, encodeURI(oldName), encodeURIComponent(oldName)])].filter(
        (v) => v && text.includes(v)
      );
      if (!variants.length) return;
      const escaped = variants.map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      // 前面是字母/数字/下划线/点/连字符时，说明它只是更长文件名的一部分（烈火.png 里的 火.png），不动
      const re = new RegExp(`(?<![\\p{L}\\p{N}_.\\-])(?:${escaped.join('|')})`, 'gu');
      const hits = [];
      let m;
      while ((m = re.exec(text))) hits.push([m.index, m.index + m[0].length]);
      // 从后往前改，前面的替换不会影响后面的位置；不整篇重写，撤销栈和光标都保住
      for (let i = hits.length - 1; i >= 0; i--) {
        editor.replaceRange(newName, editor.offsetToPos(hits[i][0]), editor.offsetToPos(hits[i][1]));
      }
    } catch (e) {
      console.error('[' + PLUGIN_ID + '] fix link failed:', e);
    }
  }

  computeTarget(file, note) {
    const root = this.attachmentRootPath();
    const ext = (file.extension || '').toLowerCase();
    const kind = this.kindOf(ext);
    const sub = this.subFolderFor(kind);

    const noteFolder = this.noteAttachmentFolder(note, root);
    const dir = normalizePath(
      [noteFolder, sub]
        .filter((p) => p && p.length)
        .join('/')
    );

    // 素材文件名永远保留原名（只做非法字符清洗），时间戳只用在目录名上
    const { base: originalBase } = splitExt(file.name);
    const base = sanitize(originalBase) || sanitize(note.basename) || '素材';
    const newName = ext ? base + '.' + ext : base;
    return { dir: dir, path: normalizePath(dir + '/' + newName), name: newName };
  }

  // 建目录 → 取唯一名 → 改名 三步串行，避免同一秒拖入多个文件时撞名
  enqueueMove(task) {
    const prev = this.moveQueue || Promise.resolve();
    const run = prev.then(task, task);
    this.moveQueue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  // 笔记改名/移动：段名跟着换，必要时搬到新的镜像父目录；文件夹改名/移动：搬整棵镜像子树
  async onNoteRenamed(file, oldPath) {
    if (this.unloaded || !file || !oldPath) return;
    const map = this.settings.noteFolders;
    if (!map) return;
    let root = '';
    try {
      root = this.attachmentRootPath();
    } catch (e) {
      return;
    }

    if (Array.isArray(file.children)) {
      const oldRel = sanitizePath(oldPath);
      const newRel = sanitizePath(file.path);
      const prefix = oldPath + '/';
      let changed = false;
      for (const key of Object.keys(map)) {
        if (key.indexOf(prefix) !== 0) continue;
        let value = map[key];
        if (oldRel && value === oldRel) value = newRel;
        else if (oldRel && value.indexOf(oldRel + '/') === 0) value = newRel + value.slice(oldRel.length);
        map[file.path + '/' + key.slice(prefix.length)] = value;
        delete map[key];
        changed = true;
      }
      if (oldRel !== newRel) {
        await this.enqueueMove(() => this.moveMirrorSubtree(root, oldRel, newRel));
      }
      if (changed) await this.saveSettings().catch(() => {});
      return;
    }

    if (!(file instanceof TFile) || file.extension !== 'md') return;

    const oldRef = {
      path: oldPath,
      basename: sanitize(oldPath.split('/').pop().replace(/\.md$/i, '')),
    };
    let folderPath = null;
    const cached = map[oldPath];
    if (cached && cached.indexOf('..') === -1) {
      const candidate = normalizePath([root, cached].join('/'));
      if (this.app.vault.getAbstractFileByPath(candidate)) folderPath = candidate;
    }
    if (!folderPath) {
      const foundRel = this.findSegmentRelForNote(oldRef, root);
      if (foundRel) folderPath = normalizePath(root + '/' + foundRel);
    }

    delete map[oldPath];
    if (folderPath) {
      const movedRel = await this.enqueueMove(() => this.renameOrMoveSegment(folderPath, file, root));
      const rel = movedRel || this.relPathOf(normalizePath(folderPath), root);
      if (rel) map[file.path] = rel;
    }
    await this.saveSettings().catch(() => {});
  }

  // 空着的镜像父目录自底向上回收；到素材总目录就停，非空立刻停
  async pruneEmptyAncestors(path, root) {
    if (!root) return;
    let cur = String(path || '');
    while (true) {
      const parent = parentOfPath(cur);
      if (!parent || parent === root || parent.indexOf(root + '/') !== 0) break;
      const folder = this.app.vault.getAbstractFileByPath(parent);
      if (!folder || !Array.isArray(folder.children) || folder.children.length) break;
      try {
        await this.trashFile(folder);
      } catch (e) {
        console.error('[' + PLUGIN_ID + '] prune empty folder failed:', parent, e);
        break;
      }
      cur = parent;
    }
  }

  // 文件夹改名/移动时，把素材总目录里对应的镜像子树一起搬过去
  async moveMirrorSubtree(root, oldRel, newRel) {
    if (!oldRel || !newRel || oldRel === newRel) return;
    const src = normalizePath(root + '/' + oldRel);
    const dst = normalizePath(root + '/' + newRel);
    const srcFolder = this.app.vault.getAbstractFileByPath(src);
    if (!srcFolder || !Array.isArray(srcFolder.children)) {
      await this.pruneEmptyAncestors(src, root);
      return;
    }
    try {
      await this.ensureFolder(parentOfPath(dst));
      if (!this.app.vault.getAbstractFileByPath(dst)) {
        await this.app.fileManager.renameFile(srcFolder, dst);
        return;
      }
      // 目标已存在：逐个合并；撞名的段不覆盖别人，留在原地并提示
      const dstFolder = this.app.vault.getAbstractFileByPath(dst);
      let skipped = 0;
      for (const child of [...srcFolder.children]) {
        const to = normalizePath(dst + '/' + child.name);
        if (this.app.vault.getAbstractFileByPath(to)) {
          skipped++;
          continue;
        }
        await this.app.fileManager.renameFile(child, to);
      }
      const again = this.app.vault.getAbstractFileByPath(src);
      if (again && Array.isArray(again.children) && again.children.length === 0) {
        await this.trashFile(again);
      }
      await this.pruneEmptyAncestors(src, root);
      if (skipped) {
        new Notice(`有 ${skipped} 个素材目录与目标重名，已留在原处`, 5000);
      }
    } catch (e) {
      console.error('[' + PLUGIN_ID + '] mirror subtree move failed:', e);
      new Notice('素材目录跟着文件夹移动失败，详见控制台', 4000);
    }
  }

  // 素材目录里有多少个文件（决定要不要提前提示）
  countFilesUnder(folderPath) {
    return this.filesUnder(folderPath).length;
  }

  // 笔记改名/移动后，把段改到新名字、搬到新的镜像父目录下（时间戳原样保留）
  async renameOrMoveSegment(folderPath, note, root) {
    const folderName = folderPath.slice(folderPath.lastIndexOf('/') + 1);
    const match = NOTE_FOLDER_RE.exec(folderName);
    if (!match) return null;
    // 沿用目录原本的后缀（素材/附件），别在一次改名里悄悄换掉命名习惯
    const kind = match[2];
    const stamp = match[3];
    const newNoteName = sanitize(note.basename);
    if (!newNoteName) return null;

    const parentRel = this.mirrorParentForNote(note);
    const newLeaf = newNoteName + '笔记' + kind + '-' + stamp;
    const targetRel = parentRel ? parentRel + '/' + newLeaf : newLeaf;
    const targetPath = normalizePath(root + '/' + targetRel);
    const currentPath = normalizePath(folderPath);
    const moved = targetPath !== currentPath;

    const folder = this.app.vault.getAbstractFileByPath(currentPath);
    if (!folder || !Array.isArray(folder.children)) return targetRel; // 目录还没建，下次直接用新位置
    if (moved && this.app.vault.getAbstractFileByPath(targetPath)) return null; // 目标已存在，保持原状

    if (moved) {
      await this.ensureFolder(parentOfPath(targetPath));
      const count = this.countFilesUnder(currentPath);
      if (count >= MANY_FILES_THRESHOLD) {
        new Notice(`正在同步素材目录（${count} 个文件）…`, 4000);
      }
    }
    if (!moved) {
      new Notice(`素材目录已同步：${targetRel}`, 4000);
      return targetRel;
    }
    try {
      await this.app.fileManager.renameFile(folder, targetPath);
    } catch (e) {
      console.error('[' + PLUGIN_ID + '] folder rename failed:', e);
      new Notice('素材目录改名失败，详见控制台', 4000);
      return null;
    }
    await this.pruneEmptyAncestors(currentPath, root);
    new Notice(`素材目录已同步：${targetRel}`, 4000);
    return targetRel;
  }

  // 只对“启用之后新建的笔记”负责；启用前就存在的笔记，插件完全不介入。
  isManagedNote(note) {
    if (!(note instanceof TFile) || note.extension !== 'md') return false;
    const ctime = Number(note.stat && note.stat.ctime) || 0;
    return ctime >= Number(this.settings.enabledAt || 0);
  }

  // 笔记是否还在库里：等待链接/排队期间用户可能已经把笔记删了
  noteStillExists(note) {
    if (!note || !note.path) return false;
    const found = this.app.vault.getAbstractFileByPath(note.path);
    return !!(found && found.extension === 'md');
  }

  async handleCreate(file) {
    const s = this.settings;
    if (this.unloaded) return;
    if (!s.enabled) return;
    if (!(file instanceof TFile)) return;

    const ext = (file.extension || '').toLowerCase();
    if (!ext || ext === 'md' || ext === 'canvas') return;

    // 关键：必须先固定住 key。改名后 file.path 会变，用 file.path 清理会漏掉原路径
    const busyKey = file.path;
    if (this.busy.has(busyKey)) return;

    const note = this.app.workspace.getActiveFile() || this.lastNote;
    if (!this.isManagedNote(note)) return;

    // 素材总目录里的笔记不接管，否则镜像会套娃
    let root = '';
    try {
      root = this.attachmentRootPath();
    } catch (e) {
      root = '';
    }
    if (root && normalizePath(note.path).indexOf(root + '/') === 0) return;

    const srcDir = file.parent ? file.parent.path : '/';

    if (s.onlyRootOrNoteFolder) {
      const allowed = this.expectedSourceDirs(note);
      if (!allowed.has(srcDir)) return;
    }

    this.busy.add(busyKey);
    try {
      // 先记下拖入前正文里这个文件名出现了几次，等下只认“变多了”
      const baseline = this.linkOccurrences(note, file);
      const linked = await this.waitForLinkInNote(note, file, s.delayMs, baseline);
      if (this.unloaded) return;
      if (!linked) {
        // 不再静默：告诉用户这一次没归位
        new Notice(`没等到链接，已跳过：${file.name}`);
        return;
      }

      const current = this.app.vault.getAbstractFileByPath(file.path);
      if (!(current instanceof TFile)) return;
      if (!this.noteStillExists(note)) return; // 笔记已被删，别再给它建目录

      const t = this.computeTarget(current, note);
      if (normalizePath(current.path) === t.path) return;

      const oldName = current.name;

      // 建目录、抢唯一名、改名串行执行，避免并发时撞名
      const finalPath = await this.enqueueMove(async () => {
        if (this.unloaded) return null;
        if (!this.noteStillExists(note)) return null; // 排队期间笔记被删了
        // 排队期间笔记可能刚被移动/改名，目标目录在锁内重算一次，避免搬进过期的路径
        const fresh = this.app.vault.getAbstractFileByPath(current.path);
        if (!(fresh instanceof TFile)) return null;
        const target = this.computeTarget(fresh, note);
        await this.ensureFolder(target.dir);
        const to = this.uniquePath(target.path);
        await this.app.fileManager.renameFile(fresh, to);
        return to;
      });
      if (!finalPath) return;

      // 再兜一层：万一链接是在改名之后才写进去的，这里补正
      const finalName = finalPath.split('/').pop();
      await sleep(120);
      if (this.unloaded) return;
      this.fixStaleLink(note, oldName, finalName);
    } catch (e) {
      console.error('[' + PLUGIN_ID + '] move failed:', e);
      const reason = e && e.message ? `：${e.message}` : '，详见控制台';
      new Notice(`素材归位失败${reason}`, 5000);
    } finally {
      this.busy.delete(busyKey);
    }
  }

  // 全库引用集合；excludeSource 用来排除即将被删除的那篇笔记
  referencedPaths(excludeSource) {
    const out = new Set();
    try {
      const links = this.app.metadataCache && this.app.metadataCache.resolvedLinks;
      if (!links) return out;
      const exclude = excludeSource ? stripTrashPath(excludeSource) : '';
      for (const [source, dests] of Object.entries(links)) {
        if (source === excludeSource) continue;
        if (exclude && stripTrashPath(source) === exclude) continue;
        // 已删除笔记的残留链接不算数，否则它们的素材目录会一直留着
        if (!this.app.vault.getAbstractFileByPath(source)) continue;
        for (const dest of Object.keys(dests || {})) out.add(dest);
      }
    } catch (e) {
      // 索引异常时返回空集合，由调用方决定是否放弃
    }
    return out;
  }

  // 链接索引看起来还没建好时，宁可不动
  isLinkIndexReady() {
    try {
      const links = this.app.metadataCache && this.app.metadataCache.resolvedLinks;
      if (!links) return false;
      const md = typeof this.app.vault.getMarkdownFiles === 'function' ? this.app.vault.getMarkdownFiles() : [];
      if (md.length === 0) return true;
      if (Object.keys(links).length > 0) return true;
      // 库里全是没有链接的笔记时 resolvedLinks 本来就会是空对象；
      // 此时用「布局已就绪」判断索引是否建好，避免把「空」误判成「没建好」
      return !!(this.app.workspace && this.app.workspace.layoutReady);
    } catch (e) {
      return false;
    }
  }

  // 当前笔记素材目录里、全库都没人引用的文件；返回 null 表示索引未就绪
  collectUnusedAttachments(note) {
    if (!this.isLinkIndexReady()) return null;
    const folderPath = this.attachmentFolderFor(note);
    if (!folderPath) return [];
    const referenced = this.referencedPaths(null);
    return this.filesUnder(folderPath).filter((f) => !referenced.has(f.path) && f.extension !== 'md');
  }

  // 优先用 Obsidian 的删除设置（系统回收站或库内 .trash），老版本退回 vault.trash
  async trashFile(file) {
    if (this.app.fileManager && typeof this.app.fileManager.trashFile === 'function') {
      await this.app.fileManager.trashFile(file);
      return;
    }
    await this.app.vault.trash(file, true);
  }

  async trashFiles(files, folders = []) {
    let done = 0;
    for (const f of files) {
      try {
        await this.trashFile(f);
        done++;
      } catch (e) {
        console.error('[' + PLUGIN_ID + '] trash failed:', f.path, e);
      }
    }
    const removed = await this.trashEmptySubfolders(folders);
    new Notice(`已移入回收站 ${done} 个素材${removed ? `、${removed} 个空目录` : ''}`, 3000);
  }

  // 清理后把空的分类子目录（图片/动图/视频/素材）也回收；段空了也收掉，再回收空的镜像父目录
  async trashEmptySubfolders(folders) {
    let removed = 0;
    let root = '';
    try {
      root = this.attachmentRootPath();
    } catch (e) {
      root = '';
    }
    for (const folderPath of folders || []) {
      const folder = this.app.vault.getAbstractFileByPath(folderPath);
      if (!folder || !Array.isArray(folder.children)) continue;
      for (const child of [...folder.children]) {
        // 取一次最新的对象，避免用到缓存的旧 children
        const fresh = this.app.vault.getAbstractFileByPath(child.path);
        if (!fresh || !Array.isArray(fresh.children) || fresh.children.length) continue;
        try {
          await this.trashFile(fresh);
          removed++;
        } catch (e) {
          console.error('[' + PLUGIN_ID + '] trash empty folder failed:', child.path, e);
        }
      }
      const again = this.app.vault.getAbstractFileByPath(folderPath);
      if (again && Array.isArray(again.children) && again.children.length === 0) {
        try {
          await this.trashFile(again);
          removed++;
          this.forgetAttachmentFolder(folderPath);
        } catch (e) {
          console.error('[' + PLUGIN_ID + '] trash empty note folder failed:', folderPath, e);
        }
      }
      await this.pruneEmptyAncestors(folderPath, root);
    }
    return removed;
  }

  forgetAttachmentFolder(folderPath) {
    const map = this.settings.noteFolders;
    if (!map) return;
    let root = '';
    try {
      root = this.attachmentRootPath();
    } catch (e) {
      return;
    }
    const rel = this.relPathOf(normalizePath(folderPath), root);
    if (!rel) return;
    let changed = false;
    for (const [key, value] of Object.entries(map)) {
      if (value === rel) {
        delete map[key];
        changed = true;
      }
    }
    if (changed) this.saveSettings().catch(() => {});
  }

  async cleanUnusedAttachments() {
    const selected = this.selectedMarkdownFiles();
    const target = selected.length ? selected : this.app.workspace.getActiveFile();
    return this.cleanUnusedAttachmentsFor(target);
  }

  // 读取文件列表里当前选中的笔记（Obsidian 没公开 API，只能读内部结构；读不到就退回活动笔记）
  selectedMarkdownFiles() {
    try {
      for (const leaf of this.app.workspace.getLeavesOfType('file-explorer')) {
        const tree = leaf && leaf.view && leaf.view.tree;
        if (!tree || !tree.selectedDoms) continue;
        const files = [];
        for (const item of Array.from(tree.selectedDoms)) {
          const file = item && item.file;
          if (file instanceof TFile && file.extension === 'md') files.push(file);
        }
        if (files.length) return files;
      }
    } catch (e) {
      // 内部结构变了就当没有多选
    }
    return [];
  }

  async cleanUnusedAttachmentsFor(target) {
    const notes = (Array.isArray(target) ? target : [target]).filter(
      (n) => n instanceof TFile && n.extension === 'md'
    );
    if (!notes.length) {
      new Notice('请先打开一篇笔记');
      return;
    }
    const folders = [];
    for (const note of notes) {
      const folder = this.attachmentFolderFor(note);
      if (folder && !folders.includes(folder)) folders.push(folder);
    }
    if (!folders.length) {
      new Notice('这些笔记没有素材目录（可能不是启用后新建的笔记）', 4000);
      return;
    }
    const files = [];
    const seen = new Set();
    for (const note of notes) {
      const list = this.collectUnusedAttachments(note);
      if (list === null) {
        new Notice('笔记索引还没就绪，稍后再试', 4000);
        return;
      }
      for (const f of list) {
        if (seen.has(f.path)) continue;
        seen.add(f.path);
        files.push(f);
      }
    }
    if (!files.length) {
      new Notice('没有未引用的素材', 3000);
      return;
    }
    new CleanupModal(this.app, files, (picked) => this.trashFiles(picked, folders)).open();
  }

  // 删笔记时，把它的素材目录一起移入回收站；还有别的笔记引用其中文件就保留
  async onNoteDeleted(file, retry = 0) {
    if (this.unloaded || !(file instanceof TFile) || file.extension !== 'md') return;
    let root = '';
    try {
      root = this.attachmentRootPath();
    } catch (e) {
      return;
    }
    const map = this.settings.noteFolders || {};
    const notePath = stripTrashPath(file.path);
    const cachedRel = map[notePath] !== undefined ? map[notePath] : map[file.path];
    // 用去掉 .trash/ 前缀的路径找目录，否则回收站里的笔记对象会匹配不到自己的段
    const folderPath = this.attachmentFolderFor({ path: notePath, basename: file.basename });
    delete map[file.path];
    delete map[notePath];
    await this.saveSettings().catch(() => {});
    if (!folderPath) return;

    // 只允许删「段」：最后一段必须是 笔记素材-时间戳。镜像父目录永远不整体删，
    // 否则一篇笔记被误判就可能带走同层其它笔记的素材。
    const leaf = folderPath.slice(folderPath.lastIndexOf('/') + 1);
    if (!NOTE_FOLDER_RE.test(leaf)) return;
    if (!cachedRel && !leaf.startsWith(sanitize(file.basename) + '笔记')) return;

    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder || !Array.isArray(folder.children)) return;
    if (!this.isLinkIndexReady()) {
      // 启动阶段索引还没建好：过一会儿再试，别把目录永久留成孤儿
      if (retry < 3 && !this.unloaded) {
        setTimeout(() => {
          if (!this.unloaded) this.onNoteDeleted(file, retry + 1).catch(() => {});
        }, 1500);
      }
      return;
    }

    const prefix = folderPath + '/';
    const referenced = this.referencedPaths(file.path);
    const stillUsed = this.app.vault
      .getFiles()
      .some((f) => f.path.indexOf(prefix) === 0 && referenced.has(f.path));
    if (stillUsed) {
      new Notice('素材仍被其它笔记引用，目录保留', 4000);
      return;
    }
    try {
      await this.trashFile(folder);
      new Notice(`素材目录已移入回收站：${leaf}`, 4000);
      await this.pruneEmptyAncestors(folderPath, root);
    } catch (e) {
      console.error('[' + PLUGIN_ID + '] trash folder failed:', e);
      new Notice('素材目录移入回收站失败，详见控制台', 4000);
    }
  }

  // 按设置的间隔排程；autoCleanDays 填 0 就不排程
  maybeScheduleAutoClean() {
    if (this.autoCleanTimer) {
      clearTimeout(this.autoCleanTimer);
      this.autoCleanTimer = null;
    }
    const days = Number(this.settings.autoCleanDays);
    if (this.unloaded || !(days > 0)) return;
    const interval = Math.max(60000, days * 86400000);
    if (!Number(this.settings.lastAutoClean)) {
      this.settings.lastAutoClean = Date.now();
      this.saveSettings().catch(() => {});
    }
    const elapsed = Date.now() - (Number(this.settings.lastAutoClean) || 0);
    const wait = Math.max(5000, interval - elapsed);
    this.autoCleanTimer = setTimeout(() => {
      this.autoCleanTimer = null;
      this.runAutoCleanWhenIdle();
    }, wait);
    if (this.autoCleanTimer && typeof this.autoCleanTimer.unref === 'function') {
      this.autoCleanTimer.unref();
    }
  }

  // 到点了再等一个空闲时机，避开正在打字/保存的瞬间
  runAutoCleanWhenIdle() {
    if (this.unloaded) return;
    const finish = () => {
      this.runAutoClean()
        .catch((e) => console.error('[' + PLUGIN_ID + '] auto clean failed:', e))
        .finally(() => this.maybeScheduleAutoClean());
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      this.idleUsesRic = true;
      this.idleHandle = window.requestIdleCallback(
        () => {
          this.idleHandle = null;
          finish();
        },
        { timeout: 60000 }
      );
      return;
    }
    this.idleUsesRic = false;
    this.idleHandle = setTimeout(() => {
      this.idleHandle = null;
      finish();
    }, 0);
  }

  // 整个素材总目录里、全库没人引用的文件；返回 null 表示索引未就绪
  collectAllUnusedAttachments() {
    if (!this.isLinkIndexReady()) return null;
    let root;
    try {
      root = this.attachmentRootPath();
    } catch (e) {
      return [];
    }
    const referenced = this.referencedPaths(null);
    const prefix = root + '/';
    return this.app.vault
      .getFiles()
      .filter((f) => f.path.indexOf(prefix) === 0 && !referenced.has(f.path) && f.extension !== 'md');
  }

  noteFolderOfFile(file) {
    const parts = String(file.path || '').split('/');
    // 从文件所在目录往上找「段」，镜像层级多深都能认出来
    for (let i = parts.length - 2; i >= 0; i--) {
      if (NOTE_FOLDER_RE.test(parts[i])) return parts.slice(0, i + 1).join('/');
    }
    return null;
  }

  async trashAllFiles(files, label) {
    const folders = new Set();
    let done = 0;
    for (const f of files) {
      const folder = this.noteFolderOfFile(f);
      if (folder) folders.add(folder);
      try {
        await this.trashFile(f);
        done++;
      } catch (e) {
        console.error('[' + PLUGIN_ID + '] trash failed:', f.path, e);
      }
    }
    if (folders.size) await this.trashEmptySubfolders([...folders]);
    showToast(
      done ? `${label}：移入回收站 ${done} 个未引用素材` : `${label}：没有发现未引用素材`,
      4000
    );
    return done;
  }

  // 设置页按钮：清理所有笔记里的未引用素材
  async cleanAllUnusedAttachments() {
    showToast('清理所有笔记：开始扫描未引用素材…', 3000);
    const files = this.collectAllUnusedAttachments();
    if (files === null) {
      showToast('笔记索引还没就绪，稍后再试', 4000);
      return;
    }
    if (!files.length) {
      showToast('清理所有笔记：没有发现未引用素材', 3000);
      return;
    }
    new CleanupModal(this.app, files, (picked) => this.trashAllFiles(picked, '清理所有笔记')).open();
  }

  // 定时自动清理：扫描整个素材总目录，把全库没人引用的文件移入回收站
  async runAutoClean() {
    if (this.unloaded || !this.settings.enabled) return 0;
    if (!this.isLinkIndexReady()) return 0;
    showToast('自动清理：开始扫描未引用素材…', 3000);
    const done = await this.trashAllFiles(this.collectAllUnusedAttachments() || [], '自动清理');
    this.settings.lastAutoClean = Date.now();
    await this.saveSettings().catch(() => {});
    return done;
  }
}

class CleanupModal extends Modal {
  constructor(app, files, onConfirm) {
    super(app);
    this.files = files;
    this.onConfirm = onConfirm;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: `未引用的素材（${this.files.length} 个）` });
    contentEl.createEl('p', {
      text: '这些文件在素材目录里，但全库没有任何笔记引用它们。确认后会移入回收站，可以恢复。',
    });
    const list = contentEl.createEl('div');
    list.style.maxHeight = '45vh';
    list.style.overflowY = 'auto';
    const shown = this.files.slice(0, 200);
    for (const f of shown) list.createEl('div', { text: f.path.split('/').pop() });
    if (this.files.length > shown.length) {
      list.createEl('div', { text: `…还有 ${this.files.length - shown.length} 个` });
    }
    const buttons = contentEl.createEl('div', { cls: 'modal-button-container' });
    const cancel = buttons.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const go = buttons.createEl('button', { text: '移入回收站', cls: 'mod-cta' });
    go.addEventListener('click', () => {
      this.close();
      this.onConfirm(this.files);
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class RouterSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    const section = (title) => {
      const row = new Setting(containerEl);
      if (typeof row.setHeading === 'function') {
        row.setName(title).setHeading();
      } else {
        containerEl.createEl('h3', { text: title });
      }
    };

    const root = sanitize(s.attachRoot) || '所有笔记素材合集';

    // 顶部提示框：Obsidian 自带的两项设置，放在一个框里，不拆成两行设置项
    const tipBox = containerEl.createEl('div', { cls: 'attachment-router-tip' });
    tipBox.createEl('div', {
      cls: 'attachment-router-tip-title',
      text: '请优先修改 Obsidian 中的以下设置',
    });
    const tipItem = (title, desc) => {
      const item = tipBox.createEl('div', { cls: 'attachment-router-tip-item' });
      item.createEl('div', { cls: 'attachment-router-tip-item-title', text: title });
      item.createEl('div', { cls: 'attachment-router-tip-item-desc', text: desc });
    };
    tipItem(
      '1. 自动更新内部链接',
      '设置 → 文件与链接 → 自动更新内部链接：保持开启（默认开启）。插件移动/改名素材时靠它同步正文里的链接；关闭后插件只会补正当前打开的笔记。'
    );
    tipItem(
      '2. 检测所有文件扩展名',
      '设置 → 文件与链接 → 检测所有文件扩展名：打开。否则 txt、zip 等 Obsidian 不能原生打开的格式不会出现在文件列表里（文件其实已经归位，只是被隐藏）。'
    );

    section('归位规则');
    new Setting(containerEl)
      .setName('素材会归到哪')
      .setDesc(
        `启用后新建的笔记，拖入或粘贴的素材会按笔记所在的文件夹镜像归到「${root}/笔记所在文件夹/笔记名笔记素材-创建时间戳/类型/」，文件名保持原样。启用前就存在的笔记不会被改动。`
      );
    new Setting(containerEl)
      .setName('清理残留素材')
      .setDesc('Ctrl+P 搜索「清理当前笔记的未引用素材」；删除笔记时，它的素材目录会自动移入回收站。');

    new Setting(containerEl)
      .setName('启用')
      .setDesc(
        `关闭后不再处理任何新素材。只对 ${formatDateAt('YYYY-MM-DD HH:mm:ss', s.enabledAt)} 之后新建的笔记生效`
      )
      .addToggle((t) =>
        t.setValue(s.enabled).onChange(async (v) => {
          s.enabled = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('清理所有笔记中的未引用素材')
      .setDesc('扫描整个素材总目录，把全库没人引用的素材移入回收站。笔记过多时扫描可能卡顿，请耐心等待')
      .addButton((b) =>
        b.setButtonText('开始清理').setCta().onClick(() => this.plugin.cleanAllUnusedAttachments())
      );

    new Setting(containerEl)
      .setName('自动清理间隔（天）')
      .setDesc('每隔这么多天扫描一次素材总目录，把全库没人引用的文件移入回收站；填 0 关闭。默认 7 天')
      .addText((t) =>
        t.setValue(String(s.autoCleanDays)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.autoCleanDays = Number.isFinite(n) && n >= 0 ? n : 7;
          this.plugin.maybeScheduleAutoClean();
          this.plugin.saveSoon();
        })
      );

    new Setting(containerEl)
      .setName('素材根目录名')
      .setDesc('所有笔记素材的统一总目录名称')
      .addText((t) =>
        t.setValue(s.attachRoot).onChange(async (v) => {
          s.attachRoot = sanitize(v) || '所有笔记素材合集';
          this.plugin.saveSoon();
        })
      );

    section('分类子目录');

    const folderField = (label, key) =>
      new Setting(containerEl)
        .setName(label)
        .addText((t) =>
          t.setValue(s[key]).onChange(async (v) => {
            s[key] = sanitize(v);
            this.plugin.saveSoon();
          })
        );

    folderField('图片目录', 'folderImage');
    folderField('动图目录', 'folderGif');
    folderField('视频目录', 'folderVideo');
    folderField('其他素材目录', 'folderOther');

    section('扩展名（英文逗号分隔）');

    const extField = (label, key, desc) =>
      new Setting(containerEl)
        .setName(label)
        .setDesc(desc)
        .addText((t) =>
          t.setValue(s[key]).onChange(async (v) => {
            s[key] = v;
            this.plugin.saveSoon();
          })
        );

    extField('图片', 'extImage', '不在下面三组里的格式都会进「其他素材」');
    extField('动图', 'extGif', 'gif、apng 等');
    extField('视频', 'extVideo', 'mp4、mov、webm 等');

    section('命名');

    new Setting(containerEl)
      .setName('素材文件名')
      .setDesc(
        '始终保留原文件名（只清洗非法字符），同名同后缀自动加 _1、_2；时间戳只用在素材目录名上，不会加到文件上。'
      );

    section('其它');

    new Setting(containerEl)
      .setName('等待链接写入的超时（毫秒）')
      .setDesc('最多等这么久，确认 Obsidian 已把链接（含 %20 编码形态）写进正文后再移动。最小 500，默认 2500')
      .addText((t) =>
        t.setValue(String(s.delayMs)).onChange(async (v) => {
          const n = parseInt(v, 10);
          s.delayMs = Number.isFinite(n) && n >= 500 ? n : 2500;
          this.plugin.saveSoon();
        })
      );

    new Setting(containerEl)
      .setName('只处理库根目录或笔记同目录的文件')
      .setDesc('安全开关，防止误移动其它文件夹里的既有文件')
      .addToggle((t) =>
        t.setValue(s.onlyRootOrNoteFolder).onChange(async (v) => {
          s.onlyRootOrNoteFolder = v;
          await this.plugin.saveSettings();
        })
      );
  }
}

module.exports = AttachmentRouter;
