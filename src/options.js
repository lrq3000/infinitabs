// options.js

const confirmDeleteCheckbox = document.getElementById('confirm-delete-checkbox');
const statusDiv = document.getElementById('status');

// Defaults
const DEFAULT_CONFIRM_DELETE = true;

// Restore options
function restoreOptions() {
  chrome.storage.local.get({
    confirmDeleteLogicalTab: DEFAULT_CONFIRM_DELETE
  }, (items) => {
    confirmDeleteCheckbox.checked = items.confirmDeleteLogicalTab;
  });
}

// Save options
function saveOptions() {
  const confirmDelete = confirmDeleteCheckbox.checked;
  chrome.storage.local.set({
    confirmDeleteLogicalTab: confirmDelete
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
