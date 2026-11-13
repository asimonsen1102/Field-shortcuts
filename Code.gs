/**
 * Micrologic Employee Portal — Apps Script backend
 *
 * Paste this into the Google Sheet's script editor (Extensions → Apps Script).
 * It reads the Roles, Links and Settings tabs and serves them as JSON
 * to the Netlify portal.
 *
 * Deploy → New deployment → Web app
 *   Execute as:      Me
 *   Who has access:  Anyone
 */

const TAB = { ROLES: 'Roles', LINKS: 'Links', SETTINGS: 'Settings' };
const CACHE_KEY = 'portal_data_v1';
const CACHE_SECONDS = 60; // edits show up on the portal within a minute

/* ------------------------------------------------------------------ */
/*  Web app entry point                                               */
/* ------------------------------------------------------------------ */

function doGet(e) {
  let body;
  try {
    const action = (e && e.parameter && e.parameter.action) || 'portal';
    if (action === 'portal') {
      body = { ok: true, data: getPortalData_() };
    } else {
      body = { ok: false, error: 'Unknown action: ' + action };
    }
  } catch (err) {
    body = { ok: false, error: String(err && err.message || err) };
  }
  return json_(body);
}

/** Admin actions: login, list, saveLink, deleteLink, logout. Body is JSON sent as text/plain. */
function doPost(e) {
  let body;
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    body = handleAdmin_(req);
  } catch (err) {
    body = { ok: false, error: String(err && err.message || err) };
  }
  return json_(body);
}

function json_(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ------------------------------------------------------------------ */
/*  Admin login + button editing                                      */
/*  Username and password live in Script Properties, never on Netlify */
/* ------------------------------------------------------------------ */

const DEFAULT_ADMIN_USER = 'micrologic';
const DEFAULT_ADMIN_PASS = 'mlaboss';
const TOKEN_HOURS = 6;
const MAX_FAILED_LOGINS = 8;   // per 15 minutes, then locked out
const LINK_HEADERS = ['Roles', 'Section', 'Title', 'Description', 'URL', 'Icon', 'Order', 'Active'];

function handleAdmin_(req) {
  if (req.action === 'login') return login_(req.username, req.password);

  const cache = CacheService.getScriptCache();
  if (!req.token || !cache.get('tok_' + req.token)) {
    return { ok: false, error: 'Session expired. Please log in again.', authError: true };
  }

  switch (req.action) {
    case 'list':       return { ok: true, data: adminList_() };
    case 'saveLink':   return { ok: true, data: saveLink_(req.link || {}) };
    case 'deleteLink': return { ok: true, data: deleteLink_(Number(req.row), req.title) };
    case 'logout':     cache.remove('tok_' + req.token); return { ok: true };
    default:           return { ok: false, error: 'Unknown action: ' + req.action };
  }
}

function adminCreds_() {
  const p = PropertiesService.getScriptProperties();
  if (!p.getProperty('ADMIN_USER')) p.setProperty('ADMIN_USER', DEFAULT_ADMIN_USER);
  if (!p.getProperty('ADMIN_PASS')) p.setProperty('ADMIN_PASS', DEFAULT_ADMIN_PASS);
  return { user: p.getProperty('ADMIN_USER'), pass: p.getProperty('ADMIN_PASS') };
}

function login_(username, password) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('login_fails') || 0);
  if (fails >= MAX_FAILED_LOGINS) {
    return { ok: false, error: 'Too many attempts. Try again in 15 minutes.' };
  }
  const c = adminCreds_();
  const okUser = String(username || '').trim().toLowerCase() === c.user.toLowerCase();
  const okPass = String(password || '') === c.pass;
  if (!okUser || !okPass) {
    cache.put('login_fails', String(fails + 1), 900);
    Utilities.sleep(700);
    return { ok: false, error: 'Incorrect username or password.' };
  }
  cache.remove('login_fails');
  const token = Utilities.getUuid();
  cache.put('tok_' + token, '1', TOKEN_HOURS * 3600);
  return { ok: true, token: token };
}

/** Every link row (active or not) with its sheet row number, plus all roles. */
function adminList_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(TAB.LINKS);
  if (!sh) throw new Error('Missing tab "Links". Run Portal → Set up sheets.');
  const values = sh.getDataRange().getValues();
  const headers = values[0].map(h => String(h).toLowerCase().replace(/\s+/g, ''));
  const links = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row.some(c => c !== '' && c !== null)) continue;
    const o = {};
    headers.forEach((h, j) => { if (h) o[h] = row[j]; });
    links.push({
      row: i + 1,
      roles: String(o.roles || '').split(',').map(slug_).filter(Boolean),
      section: String(o.section || ''),
      title: String(o.title || ''),
      description: String(o.description || ''),
      url: String(o.url || ''),
      icon: String(o.icon || 'link').toLowerCase(),
      order: o.order === '' ? '' : Number(o.order),
      active: isActive_(o.active)
    });
  }
  const roles = readTable_(ss, TAB.ROLES)
    .filter(r => r.roleid)
    .map(r => ({ id: slug_(r.roleid), label: String(r.label || r.roleid), color: String(r.color || '#3b82f6'), active: isActive_(r.active) }));
  return { links: links, roles: roles };
}

function saveLink_(link) {
  const title = clean_(link.title);
  if (!title) throw new Error('Button name is required.');
  const url = String(link.url || '').trim();
  if (url && !/^https:\/\//i.test(url)) throw new Error('Link must start with https://');
  const roles = (link.roles || []).map(slug_).filter(Boolean);
  if (!roles.length) throw new Error('Choose at least one role.');

  const values = {
    roles: roles.join(', '),
    section: clean_(link.section) || 'General',
    title: title,
    description: clean_(link.description),
    url: url,
    icon: slug_(link.icon) || 'link',
    order: link.order === '' || link.order === null || isNaN(Number(link.order)) ? '' : Number(link.order),
    active: link.active === false ? 'FALSE' : 'TRUE'
  };

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.LINKS);
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(h => String(h).toLowerCase().replace(/\s+/g, ''));
    const rowValues = headers.map(h => (h in values ? values[h] : ''));

    if (link.row) {
      const r = Number(link.row);
      const titleCol = headers.indexOf('title') + 1;
      const current = String(sh.getRange(r, titleCol).getValue());
      if (current !== String(link.originalTitle || '')) {
        throw new Error('The sheet changed since you opened it. Reload and try again.');
      }
      // keep any extra columns the admin form doesn't manage
      const existing = sh.getRange(r, 1, 1, headers.length).getValues()[0];
      const merged = headers.map((h, i) => (h in values ? values[h] : existing[i]));
      sh.getRange(r, 1, 1, headers.length).setValues([merged]);
    } else {
      sh.appendRow(rowValues);
    }
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove(CACHE_KEY);
  return adminList_();
}

function deleteLink_(row, title) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TAB.LINKS);
    const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(h => String(h).toLowerCase().replace(/\s+/g, ''));
    const titleCol = headers.indexOf('title') + 1;
    if (!row || row < 2 || row > sh.getLastRow()) throw new Error('Button not found. Reload and try again.');
    if (String(sh.getRange(row, titleCol).getValue()) !== String(title || '')) {
      throw new Error('The sheet changed since you opened it. Reload and try again.');
    }
    sh.deleteRow(row);
  } finally {
    lock.releaseLock();
  }
  CacheService.getScriptCache().remove(CACHE_KEY);
  return adminList_();
}

/** Trims text and stops it being read as a spreadsheet formula. */
function clean_(v) {
  const s = String(v == null ? '' : v).trim().slice(0, 300);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** Run from the editor to change the admin login. Edit the two values first. */
function changeAdminLogin() {
  const NEW_USER = 'micrologic';
  const NEW_PASS = 'mlaboss';
  PropertiesService.getScriptProperties().setProperties({ ADMIN_USER: NEW_USER, ADMIN_PASS: NEW_PASS });
  SpreadsheetApp.getUi().alert('Admin login updated.');
}

/* ------------------------------------------------------------------ */
/*  Build the portal payload from the sheet                           */
/* ------------------------------------------------------------------ */

function getPortalData_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get(CACHE_KEY);
  if (cached) return JSON.parse(cached);

  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Settings: Key | Value
  const settings = {};
  readTable_(ss, TAB.SETTINGS).forEach(r => {
    if (r.key) settings[String(r.key).trim()] = r.value;
  });

  // Roles: RoleID | Label | Description | Color | Order | Active
  const roles = readTable_(ss, TAB.ROLES)
    .filter(r => r.roleid && isActive_(r.active))
    .map(r => ({
      id: slug_(r.roleid),
      label: String(r.label || r.roleid),
      description: String(r.description || ''),
      color: String(r.color || '#3b82f6'),
      order: Number(r.order) || 999
    }))
    .sort((a, b) => a.order - b.order);

  // Links: Roles | Section | Title | Description | URL | Icon | Order | Active
  const links = readTable_(ss, TAB.LINKS)
    .filter(r => r.title && isActive_(r.active))
    .map(r => ({
      roles: String(r.roles || '').split(',').map(slug_).filter(Boolean),
      section: String(r.section || 'General'),
      title: String(r.title),
      description: String(r.description || ''),
      url: String(r.url || '').trim(),
      icon: String(r.icon || 'link').trim().toLowerCase(),
      order: Number(r.order) || 999
    }))
    .sort((a, b) => a.order - b.order);

  const data = { settings, roles, links, updated: new Date().toISOString() };
  cache.put(CACHE_KEY, JSON.stringify(data), CACHE_SECONDS);
  return data;
}

/** Reads a tab into an array of objects keyed by lower-case header (spaces removed). */
function readTable_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Missing tab "' + name + '". Run Portal → Set up sheets.');
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(h => String(h).toLowerCase().replace(/\s+/g, ''));
  return values.slice(1)
    .filter(row => row.some(c => c !== '' && c !== null))
    .map(row => {
      const o = {};
      headers.forEach((h, i) => { if (h) o[h] = row[i]; });
      return o;
    });
}

function isActive_(v) {
  if (v === '' || v === null || v === undefined) return true; // blank = active
  if (v === true) return true;
  return /^(true|yes|y|1|active)$/i.test(String(v).trim());
}

function slug_(v) {
  return String(v || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/* ------------------------------------------------------------------ */
/*  Sheet menu, cache refresh, and one-time setup                     */
/* ------------------------------------------------------------------ */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Portal')
    .addItem('Set up sheets (first time)', 'setupSheets')
    .addItem('Refresh portal now', 'clearPortalCache')
    .addItem('Preview portal data', 'previewPortalData')
    .addToUi();
}

/** Any edit clears the cache so the portal updates right away. */
function onEdit() {
  CacheService.getScriptCache().remove(CACHE_KEY);
}

function clearPortalCache() {
  CacheService.getScriptCache().remove(CACHE_KEY);
  SpreadsheetApp.getActive().toast('Portal will show the latest sheet data.', 'Portal', 4);
}

function previewPortalData() {
  clearPortalCache();
  const data = getPortalData_();
  const msg = data.roles.length + ' roles, ' + data.links.length + ' links\n\n' +
    data.roles.map(r => '• ' + r.label + ': ' +
      data.links.filter(l => l.roles.indexOf(r.id) > -1).length + ' buttons').join('\n');
  SpreadsheetApp.getUi().alert('Portal data', msg, SpreadsheetApp.getUi().ButtonSet.OK);
}

/** Creates the three tabs with headers and starter rows. Safe to run again: existing tabs are left alone. */
function setupSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  makeTab_(ss, TAB.SETTINGS, ['Key', 'Value'], [
    ['CompanyName', 'MICROLOGIC'],
    ['PortalTitle', 'EMPLOYEE PORTAL'],
    ['Tagline', 'Your central hub for field operations and project management.'],
    ['Announcement', ''],
    ['SupportEmail', '']
  ]);

  makeTab_(ss, TAB.ROLES, ['RoleID', 'Label', 'Description', 'Color', 'Order', 'Active'], [
    ['technician', 'Field Technician', 'Product and toolbox requests', '#4fb39a', 1, 'TRUE'],
    ['pm', 'Project Manager', 'Product requests', '#74cbc1', 2, 'TRUE'],
    ['admin', 'Administrator', 'Employee management and portal settings', '#1b7a6c', 3, 'FALSE']
  ]);

  makeTab_(ss, TAB.LINKS, ['Roles', 'Section', 'Title', 'Description', 'URL', 'Icon', 'Order', 'Active'], [
    ['technician', 'Field Technician', 'Product Request', 'Request parts, products, and supplies.', 'https://script.google.com/a/macros/micrologic.net/s/AKfycbzj9CN73CZliysBJuxk-fIuNDG8LXBtXKCQG-Q8BvjmuqknKxOaU24_o0JGEEmgDKc/exec', 'clipboard', 1, 'TRUE'],
    ['technician', 'Field Technician', 'Toolbox Request', 'Request tools and equipment for your toolbox.', 'https://script.google.com/a/macros/micrologic.net/s/AKfycbw6DN9yHzlnjX7AFThCwuHp8AK3ABQ2q0Ua1H4ciRKk3WeLItth_K4sBnbiPnGMQmfM/exec', 'box', 2, 'TRUE'],
    ['pm', 'Project Management', 'Product Request', 'Request parts, products, and supplies.', 'https://script.google.com/a/macros/micrologic.net/s/AKfycbzj9CN73CZliysBJuxk-fIuNDG8LXBtXKCQG-Q8BvjmuqknKxOaU24_o0JGEEmgDKc/exec', 'clipboard', 10, 'TRUE'],
    ['admin', 'Administration', 'Employee Management', 'Add employees and assign roles.', '', 'idcard', 20, 'TRUE'],
    ['admin', 'Administration', 'Portal Settings', 'Edit this portal’s Google Sheet.', '', 'gear', 21, 'TRUE']
  ]);

  clearPortalCache();
  SpreadsheetApp.getUi().alert('Portal sheets are ready. Paste each page’s web address into the URL column on the Links tab.');
}

function makeTab_(ss, name, headers, rows) {
  if (ss.getSheetByName(name)) return;
  const sh = ss.insertSheet(name);
  sh.getRange(1, 1, 1, headers.length).setValues([headers])
    .setFontWeight('bold').setBackground('#1b7a6c').setFontColor('#ffffff');
  if (rows.length) sh.getRange(2, 1, rows.length, headers.length).setValues(rows);
  sh.setFrozenRows(1);
  sh.autoResizeColumns(1, headers.length);
}
