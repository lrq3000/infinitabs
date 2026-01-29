// options.js

const confirmDeleteCheckbox = document.getElementById('confirm-delete-checkbox');
const selectLastActiveCheckbox = document.getElementById('select-last-active-checkbox');
const maxTabHistoryInput = document.getElementById('max-tab-history-input');
const historySizeInput = document.getElementById('history-size-input');
const reloadOnRestartCheckbox = document.getElementById('reload-on-restart-checkbox');
const restoreMountedTabsCheckbox = document.getElementById('restore-mounted-tabs-checkbox');
const activeTabColorInput = document.getElementById('active-tab-color-input');
const selectedTabColorInput = document.getElementById('selected-tab-color-input');
const nameSessionsWithWordsCheckbox = document.getElementById('name-sessions-with-words-checkbox');
const statusDiv = document.getElementById('status');

// Defaults
const DEFAULT_CONFIRM_DELETE = true;
const DEFAULT_SELECT_LAST_ACTIVE = true;
const DEFAULT_MAX_TAB_HISTORY = 100;
const DEFAULT_HISTORY_SIZE = 50;
const DEFAULT_RELOAD_ON_RESTART = false;
const DEFAULT_RESTORE_MOUNTED_TABS = false;
const DEFAULT_NAME_SESSIONS_WITH_WORDS = true;

// Restore options
function restoreOptions() {
  chrome.storage.local.get({
    confirmDeleteLogicalTab: DEFAULT_CONFIRM_DELETE,
    selectLastActiveTab: DEFAULT_SELECT_LAST_ACTIVE,
    maxTabHistory: DEFAULT_MAX_TAB_HISTORY,
    historySize: DEFAULT_HISTORY_SIZE,
    reloadOnRestart: DEFAULT_RELOAD_ON_RESTART,
    restoreMountedTabs: DEFAULT_RESTORE_MOUNTED_TABS,
    activeTabBg: '',
    selectedTabBg: '',
    nameSessionsWithWords: DEFAULT_NAME_SESSIONS_WITH_WORDS
  }, (items) => {
    confirmDeleteCheckbox.checked = items.confirmDeleteLogicalTab;
    selectLastActiveCheckbox.checked = items.selectLastActiveTab;
    maxTabHistoryInput.value = items.maxTabHistory;
    historySizeInput.value = items.historySize;
    reloadOnRestartCheckbox.checked = items.reloadOnRestart;
    restoreMountedTabsCheckbox.checked = items.restoreMountedTabs;
    activeTabColorInput.value = items.activeTabBg;
    selectedTabColorInput.value = items.selectedTabBg;
    nameSessionsWithWordsCheckbox.checked = items.nameSessionsWithWords;
  });
}

// Normalize color before save, ensures only valid CSS colors are saved
function normalizeColor(value) {
  const v = value.trim();
  return v && CSS.supports('color', v) ? v : '';
}

// Save options
function saveOptions() {
  const confirmDelete = confirmDeleteCheckbox.checked;
  const selectLastActive = selectLastActiveCheckbox.checked;
  const parsedMaxTabHistory = parseInt(maxTabHistoryInput.value, 10);
  const maxTabHistory = Number.isFinite(parsedMaxTabHistory)
    ? Math.min(500, Math.max(10, parsedMaxTabHistory))
    : DEFAULT_MAX_TAB_HISTORY;
  const historySize = parseInt(historySizeInput.value, 10) || 50;
  const reloadOnRestart = reloadOnRestartCheckbox.checked;
  const restoreMountedTabs = restoreMountedTabsCheckbox.checked;
  const activeTabBg = normalizeColor(activeTabColorInput.value);
  const selectedTabBg = normalizeColor(selectedTabColorInput.value);
  const nameSessionsWithWords = nameSessionsWithWordsCheckbox.checked;
  chrome.storage.local.set({
    confirmDeleteLogicalTab: confirmDelete,
    selectLastActiveTab: selectLastActive,
    maxTabHistory: maxTabHistory,
    historySize: historySize,
    reloadOnRestart: reloadOnRestart,
    restoreMountedTabs: restoreMountedTabs,
    activeTabBg: activeTabBg,
    selectedTabBg: selectedTabBg,
    nameSessionsWithWords: nameSessionsWithWords
  }, () => {
    // Update status to let user know options were saved.
    statusDiv.style.opacity = '1';
    setTimeout(() => {
      statusDiv.style.opacity = '0';
    }, 1500);
  });
}

// Helper for debouncing
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), wait);
  };
}

const debouncedSaveOptions = debounce(saveOptions, 250);

document.addEventListener('DOMContentLoaded', restoreOptions);
confirmDeleteCheckbox.addEventListener('change', saveOptions);
selectLastActiveCheckbox.addEventListener('change', saveOptions);
maxTabHistoryInput.addEventListener('change', saveOptions);
historySizeInput.addEventListener('change', saveOptions);
reloadOnRestartCheckbox.addEventListener('change', saveOptions);
restoreMountedTabsCheckbox.addEventListener('change', saveOptions);
activeTabColorInput.addEventListener('input', debouncedSaveOptions);
selectedTabColorInput.addEventListener('input', debouncedSaveOptions);
nameSessionsWithWordsCheckbox.addEventListener('change', saveOptions);
