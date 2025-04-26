"use strict";

import "./popup.css";

/***************** UI elements *****************/
// Available models configuration
const availableModels = [
  { name: "Granite 3.2 2B it q8_0", id: "granite-3.2-2b-instruct-q8_0" },
];

document.addEventListener('DOMContentLoaded', () => {
  // Set up model selector
  const modelSelector = document.createElement('select');
  modelSelector.id = 'model-selector';
  
  availableModels.forEach(model => {
    const option = document.createElement('option');
    option.value = model.id;
    option.text = model.name;
    option.disabled = true;
    modelSelector.appendChild(option);
  });

  // Create clear cache button
  const clearCacheButton = document.createElement('button');
  clearCacheButton.textContent = 'Clear Cache';
  clearCacheButton.className = 'btn';
  clearCacheButton.addEventListener('click', clearCache);

  // Add controls to page
  const controlsContainer = document.createElement('div');
  controlsContainer.className = 'controls-container';
  
  const modelControls = document.createElement('div');
  modelControls.className = 'model-controls';
  modelControls.appendChild(modelSelector);
  modelControls.appendChild(clearCacheButton);
  
  controlsContainer.appendChild(modelControls);
  document.body.insertBefore(controlsContainer, document.body.firstChild);

  // Save model selection to storage
  modelSelector.addEventListener('change', (event) => {
    const modelId = (event.target as HTMLSelectElement).value;
    chrome.storage.local.set({ selectedModel: modelId }, () => {
      showSuccessMessage('Model preference saved');
      clearCache(); // Clear cache when model changes
    });
  });

  // Load saved model preference
  chrome.storage.local.get(['selectedModel'], (result) => {
    if (result.selectedModel) {
      modelSelector.value = result.selectedModel;
    }
  });
});

// Function to clear IndexedDB cache
async function clearCache() {
  try {
    // Clear IndexedDB cache
    const request = indexedDB.deleteDatabase("web-llm-cache");
    request.onsuccess = () => {
      // Clear content script cache
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id) {
          chrome.tabs.sendMessage(tabs[0].id, { action: 'clearCache' }, (response) => {
            if (chrome.runtime.lastError) {
              console.error("Error clearing content cache:", chrome.runtime.lastError);
              showError('Failed to clear content cache');
              return;
            }
            console.log("Cache cleared successfully");
            showSuccessMessage('All caches cleared successfully');
          });
        }
      });
    };
  } catch (error) {
    console.error("Error clearing cache:", error);
    showError('Failed to clear cache');
  }
}

// Function to show error message
function showError(message: string) {
  const messageDiv = document.createElement('div');
  messageDiv.innerHTML = `
    <div class="error-message">
      <i class="fa fa-exclamation-circle"></i>
      <span>${message}</span>
    </div>
  `;
  messageDiv.style.cssText = `
    background-color: #f44336;
    color: white;
    padding: 10px;
    margin-top: 10px;
    border-radius: 4px;
  `;
  document.body.appendChild(messageDiv);
  setTimeout(() => messageDiv.remove(), 3000);
}

// Function to show success message
function showSuccessMessage(message: string) {
  const messageDiv = document.createElement('div');
  messageDiv.textContent = message;
  messageDiv.style.cssText = `
    background-color: #4caf50;
    color: white;
    padding: 10px;
    margin-top: 10px;
    border-radius: 4px;
  `;
  document.body.appendChild(messageDiv);
  setTimeout(() => messageDiv.remove(), 3000);
}
