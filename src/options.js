// options.js

const confirmDeleteCheckbox = document.getElementById('confirm-delete-checkbox');
const historyLimitInput = document.getElementById('history-limit-input');
const statusDiv = document.getElementById('status');

// Defaults
const DEFAULT_CONFIRM_DELETE = true;
const DEFAULT_HISTORY_LIMIT = 50;

// Restore options
function restoreOptions() {
  chrome.storage.local.get({
    confirmDeleteLogicalTab: DEFAULT_CONFIRM_DELETE,
    workspaceHistoryLimit: DEFAULT_HISTORY_LIMIT
  }, (items) => {
    confirmDeleteCheckbox.checked = items.confirmDeleteLogicalTab;
    historyLimitInput.value = items.workspaceHistoryLimit;
  });
}

// Save options
function saveOptions() {
  const confirmDelete = confirmDeleteCheckbox.checked;
  const historyLimit = parseInt(historyLimitInput.value, 10);

  chrome.storage.local.set({
    confirmDeleteLogicalTab: confirmDelete,
    workspaceHistoryLimit: historyLimit
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
historyLimitInput.addEventListener('change', saveOptions);
