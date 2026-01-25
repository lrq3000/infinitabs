// options.js

const confirmDeleteCheckbox = document.getElementById('confirm-delete-checkbox');
const selectLastActiveCheckbox = document.getElementById('select-last-active-checkbox');
const maxTabHistoryInput = document.getElementById('max-tab-history-input');
const historySizeInput = document.getElementById('history-size-input');
const reloadOnRestartCheckbox = document.getElementById('reload-on-restart-checkbox');
const statusDiv = document.getElementById('status');

// Defaults
const DEFAULT_CONFIRM_DELETE = true;
const DEFAULT_SELECT_LAST_ACTIVE = false;
const DEFAULT_MAX_TAB_HISTORY = 100;
const DEFAULT_HISTORY_SIZE = 50;
const DEFAULT_RELOAD_ON_RESTART = false;

// Restore options
function restoreOptions() {
  chrome.storage.local.get({
    confirmDeleteLogicalTab: DEFAULT_CONFIRM_DELETE,
    selectLastActiveTab: DEFAULT_SELECT_LAST_ACTIVE,
    maxTabHistory: DEFAULT_MAX_TAB_HISTORY,
    historySize: DEFAULT_HISTORY_SIZE,
    reloadOnRestart: DEFAULT_RELOAD_ON_RESTART
  }, (items) => {
    confirmDeleteCheckbox.checked = items.confirmDeleteLogicalTab;
    selectLastActiveCheckbox.checked = items.selectLastActiveTab;
    maxTabHistoryInput.value = items.maxTabHistory;
    historySizeInput.value = items.historySize;
    reloadOnRestartCheckbox.checked = items.reloadOnRestart;
  });
}

// Save options
function saveOptions() {
  const confirmDelete = confirmDeleteCheckbox.checked;
  const selectLastActive = selectLastActiveCheckbox.checked;
  const maxTabHistory = parseInt(maxTabHistoryInput.value, 10) || 100;
  const historySize = parseInt(historySizeInput.value, 10) || 50;
  const reloadOnRestart = reloadOnRestartCheckbox.checked;
  chrome.storage.local.set({
    confirmDeleteLogicalTab: confirmDelete,
    selectLastActiveTab: selectLastActive,
    maxTabHistory: maxTabHistory,
    historySize: historySize,
    reloadOnRestart: reloadOnRestart
  }, () => {
    // Update status to let user know options were saved.
    statusDiv.style.opacity = '1';
    setTimeout(() => {
      statusDiv.style.opacity = '0';
    }, 1500);
  });
}

document.addEventListener('DOMContentLoaded', restoreOptions);
confirmDeleteCheckbox.addEventListener('change', saveOptions);
selectLastActiveCheckbox.addEventListener('change', saveOptions);
maxTabHistoryInput.addEventListener('change', saveOptions);
historySizeInput.addEventListener('change', saveOptions);
reloadOnRestartCheckbox.addEventListener('change', saveOptions);
