// options.js

const confirmDeleteCheckbox = document.getElementById('confirm-delete-checkbox');
const historySizeInput = document.getElementById('history-size-input');
const reloadOnRestartCheckbox = document.getElementById('reload-on-restart-checkbox');
const statusDiv = document.getElementById('status');

// Defaults
const DEFAULT_CONFIRM_DELETE = true;
const DEFAULT_HISTORY_SIZE = 50;
const DEFAULT_RELOAD_ON_RESTART = false;

// Restore options
function restoreOptions() {
  chrome.storage.local.get({
    confirmDeleteLogicalTab: DEFAULT_CONFIRM_DELETE,
    historySize: DEFAULT_HISTORY_SIZE,
    reloadOnRestart: DEFAULT_RELOAD_ON_RESTART
  }, (items) => {
    confirmDeleteCheckbox.checked = items.confirmDeleteLogicalTab;
    historySizeInput.value = items.historySize;
    reloadOnRestartCheckbox.checked = items.reloadOnRestart;
  });
}

// Save options
function saveOptions() {
  const confirmDelete = confirmDeleteCheckbox.checked;
  const historySize = parseInt(historySizeInput.value, 10) || 50;
  const reloadOnRestart = reloadOnRestartCheckbox.checked;
  chrome.storage.local.set({
    confirmDeleteLogicalTab: confirmDelete,
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
historySizeInput.addEventListener('change', saveOptions);
reloadOnRestartCheckbox.addEventListener('change', saveOptions);
