import { clearAnalyzedEmails, getAnalyzedEmail, storeAnalyzedEmail } from './db';
import { clearMessageHandlers, sendEmailContent } from './messageQueue';
import { AnalysisResult, EmailContent, newAnalysisResult, ResponseMessage } from './types';

// Keep WeakSets for processed elements and badge elements
let processedElements = new WeakSet<Element>();
let badgeElements = new WeakSet<Element>();

let lastRun: number = 0;
let throttleTimer: number | null = null;
let activePopup: HTMLElement | null = null;

// Add message listener for cache clearing
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'clearCache') {
    // Remove existing badges
    document.querySelectorAll('.email-safety-badge').forEach((badge) => {
      badge.remove();
    });

    clearAnalyzedEmails()
      .then(() => {
        processedElements = new WeakSet<Element>();
        badgeElements = new WeakSet<Element>();
        clearMessageHandlers();
        console.log('Email Safety Scanner: Cache and badges cleared');
        sendResponse({ success: true });
      })
      .catch((error) => {
        console.error('Error clearing cache:', error);
        sendResponse({ success: false, error });
      });
    return true; // Indicates async response
  }
});

// Initialize if we're in Gmail
initializeObserver();

function initializeObserver(): void {
  const observer = new MutationObserver((_) => {
    if (throttleTimer) return;

    const now = Date.now();
    if (lastRun === 0 || now - lastRun > 100) {
      lastRun = now;
      handleEmailChanges();
    } else {
      throttleTimer = window.setTimeout(() => {
        throttleTimer = null;
        handleEmailChanges();
      }, Math.max(0, 100 - (now - lastRun)));
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
  
  // Add global click event listener to handle popup closing
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement;
    // Close popup if clicking outside of any badge
    if (activePopup && !target.closest('.email-safety-badge')) {
      closeActivePopup();
    }
  });
}

// Close any currently open popup
function closeActivePopup(): void {
  if (activePopup) {
    document.body.classList.remove('email-safety-popup-open');
    activePopup.classList.remove('popup-active');
    activePopup = null;
  }
}

async function handleEmailChanges(): Promise<void> {
  try {
    const emailContainers = document.querySelectorAll('div.adn.ads');

    for (const container of emailContainers) {
      if (processedElements.has(container)) continue;

      addLoadingBadge(container as HTMLElement);
      processedElements.add(container);
      const emailContent = extractEmailContent(container as HTMLElement);

      if (!emailContent) {
        console.log('Email Safety Scanner: Failed to extract email content');
        continue;
      }

      const hash = await hashContent(JSON.stringify(emailContent));
      const storedResult = await getAnalyzedEmail(hash);

      if (storedResult) {
        displayBadge(container as HTMLElement, storedResult);
        continue;
      }

      analyzeEmail(emailContent, container as HTMLElement, hash);
    }
  } catch (error) {
    console.error('Email Safety Scanner: Error handling email changes:', error);
  }
}

/**
 * Trims excessive whitespace from text content
 * - Replaces multiple spaces with a single space
 * - Replaces 2+ newlines with double newlines
 * - Trims leading/trailing whitespace
 */
function normalizeWhitespace(text: string): string {
  if (!text) return '';

  return text
    .replace(/[ \t]+/g, ' ') // Replace multiple spaces/tabs with single space
    .replace(/(?:\s*\n){2,}\s*/g, '\n\n') // Replace 2+ newlines (with optional surrounding spaces) with double newline
    .trim(); // Remove leading/trailing whitespace
}

function extractEmailContent(container: HTMLElement): EmailContent | null {
  const subject = container.querySelector('h2.hP')?.textContent ?? '';
  const body = container.querySelector('div.a3s.aiL')?.textContent ?? '';
  const sender = container.querySelector('span.gD')?.getAttribute('email') ?? '';
  const urls = Array.from(container.querySelectorAll('a')).map((a) => a.href);

  return { subject, body: normalizeWhitespace(body), sender, urls };
}

async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function analyzeEmail(emailContent: EmailContent, container: HTMLElement, hash: string): void {
  console.log('Email Safety Scanner: Starting email analysis');

  sendEmailContent(emailContent, (response: ResponseMessage) => {
    if (response.responseType === 'error') {
      const errorResult = newAnalysisResult({
        brief_analysis: response.brief_analysis || 'Analysis failed',
        type: 'error',
        confidence: 0
      });
      displayBadge(container, errorResult);
      return;
    }

    if (response.responseType === 'completion') {
      const analysisResult = newAnalysisResult({
        brief_analysis: response.brief_analysis,
        type: response.type,
        confidence: response.confidence,
      });

      // Store in IndexedDB instead of in-memory Map
      storeAnalyzedEmail(hash, analysisResult)
        .then(() => {
          displayBadge(container, analysisResult);
        })
        .catch((error) => {
          console.error('Failed to store analysis result:', error);
          // Still display badge even if storage fails
          displayBadge(container, analysisResult);
        });
    }
  });
}

function addBadgeToEmail(container: HTMLElement, badge: HTMLElement): void {
  // Remove any existing badge first
  const existingBadge = container.querySelector('.email-safety-badge');
  if (existingBadge) {
    badgeElements.delete(existingBadge);
    existingBadge.remove();
  }
  
  // Find the first table row in the email container
  const firstRow = container.querySelector('tr');
  if (firstRow) {
    // Create a new table cell for the badge if needed
    let badgeCell = firstRow.querySelector('.badge-cell');
    if (!badgeCell) {
      badgeCell = document.createElement('td');
      badgeCell.className = 'badge-cell';
      firstRow.appendChild(badgeCell);
    }
    
    // Add the badge to the cell
    badgeCell.innerHTML = '';
    badgeCell.appendChild(badge);
  } else {
    // Fallback to previous approach if no table row found
    const toolbar = container.querySelector('.ade');
    if (toolbar) {
      toolbar.appendChild(badge);
    } else {
      const headerArea = container.querySelector('.ha');
      if (headerArea) {
        headerArea.appendChild(badge);
      }
    }
  }

  // Ensure proper event handling for the badge
  setupBadgeInteractions(badge);
}

function setupBadgeInteractions(badge: HTMLElement): void {
  // Add click handler for manual popup toggle
  badge.addEventListener('click', (event) => {
    event.stopPropagation();
    
    if (badge.classList.contains('popup-active')) {
      closeActivePopup();
    } else {
      // Close any other active popup first
      closeActivePopup();
      
      // Setup this popup as active
      activePopup = badge;
      badge.classList.add('popup-active');
      document.body.classList.add('email-safety-popup-open');
      
      // Ensure popup is positioned correctly by forcing layout recalculation
      const popup = badge.querySelector('.badge-info');
      if (popup) {
        // Force popup to appear and recalculate position
        (popup as HTMLElement).style.display = 'flex';
        
        // Check if popup would go off-screen to the right
        const popupRect = popup.getBoundingClientRect();
        if (popupRect.right > window.innerWidth) {
          (popup as HTMLElement).style.right = 'auto';
          (popup as HTMLElement).style.left = `${Math.max(0, window.innerWidth - popupRect.width - 20)}px`;
        }
      }
    }
  });
  
  // Handle hover effects in addition to click
  badge.addEventListener('mouseenter', () => {
    // Add a class to the badge container that's being hovered
    badge.parentElement?.classList.add('badge-container-hovered');
    
    // Force hardware acceleration for smoother animations
    const popup = badge.querySelector('.badge-info') as HTMLElement;
    if (popup) {
      popup.style.transform = 'translateZ(0)';
    }
  });
  
  badge.addEventListener('mouseleave', () => {
    // Only remove hover class if this isn't the active popup
    if (badge !== activePopup) {
      badge.parentElement?.classList.remove('badge-container-hovered');
      
      // Hide the popup when not active and mouse leaves
      const popup = badge.querySelector('.badge-info') as HTMLElement;
      if (popup) {
        popup.style.display = 'none';
      }
    }
  });
}

function addLoadingBadge(container: HTMLElement): void {
  console.log('add loading badge');

  const loadingBadge = document.createElement('div');
  loadingBadge.className = 'email-safety-badge loading';

  const badgeIcon = document.createElement('div');
  badgeIcon.className = 'badge-icon';

  loadingBadge.appendChild(badgeIcon);

  // Add badge to email (existing badges will be handled by addBadgeToEmail)
  addBadgeToEmail(container, loadingBadge);
}

function displayBadge(container: HTMLElement, result: AnalysisResult): void {
  const badge = document.createElement('div');
  badge.className = 'email-safety-badge';
  badgeElements.add(badge);

  let icon = '';
  let color = '';

  switch (result.type) {
    case 'safe':
      icon = 'fa-check';
      color = 'green';
      break;
    case 'spam':
      icon = 'fa-trash';
      color = 'yellow';
      break;
    case 'unknown_threat':
      icon = 'fa-exclamation';
      color = 'yellow';
      break;
    case 'malware':
      icon = 'fa-unlock';
      color = 'red';
      break;
    case 'data_exfiltration':
      icon = 'fa-file-arrow-up';
      color = 'red';
      break;
    case 'phishing':
      icon = 'fa-fish';
      color = 'red';
      break;
    case 'extortion':
      icon = 'fa-user-secret';
      color = 'red';
      break;
    case 'scam':
      icon = 'fa-dollar-sign';
      color = 'red';
      break;
    case 'error':
      icon = 'fa-times';
      color = 'red';
      break;
    default:
      console.error('Unknown email type:', result.type);
      icon = 'fa-question';
      color = 'yellow';
      break;
  }

  // Create badge icon
  const badgeIcon = document.createElement('div');
  badgeIcon.className = `badge-icon ${color}`;

  const iconElement = document.createElement('i');
  iconElement.className = `fa ${icon}`;

  badgeIcon.appendChild(iconElement);
  badge.appendChild(badgeIcon);

  // Create badge info container
  const badgeInfo = document.createElement('div');
  badgeInfo.className = 'badge-info';
  badgeInfo.setAttribute('role', 'tooltip');
  badgeInfo.setAttribute('aria-hidden', 'true');

  // Add badge type
  const badgeType = document.createElement('span');
  badgeType.className = 'badge-type';
  badgeType.textContent = result.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Normal';
  badgeInfo.appendChild(badgeType);

  // Add badge analysis
  const badgeAnalysis = document.createElement('span');
  badgeAnalysis.className = 'badge-analysis';
  badgeAnalysis.textContent = result.brief_analysis;
  badgeInfo.appendChild(badgeAnalysis);

  // Add badge confidence
  const badgeConfidence = document.createElement('span');
  badgeConfidence.className = 'badge-confidence';
  badgeConfidence.textContent = `Confidence: ${Math.round(result.confidence * 100)}%`;
  badgeInfo.appendChild(badgeConfidence);

  badge.appendChild(badgeInfo);

  // Add badge to email
  addBadgeToEmail(container, badge);
}
