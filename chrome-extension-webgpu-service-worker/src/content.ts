import { clearAnalyzedEmails, getAnalyzedEmail, storeAnalyzedEmail } from './db';
import { clearMessageHandlers, sendEmailContent } from './messageQueue';
import { AnalysisResult, EmailContent, newAnalysisResult, ResponseMessage } from './types';

// Keep WeakSets for processed elements and badge elements
let processedElements = new WeakSet<Element>();
let badgeElements = new WeakSet<Element>();

let lastRun: number = 0;
let throttleTimer: number | null = null;

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
 * - Replaces 3+ newlines with double newlines
 * - Trims leading/trailing whitespace
 */
function normalizeWhitespace(text: string): string {
  if (!text) return '';

  return text
    .replace(/[ \t]+/g, ' ') // Replace multiple spaces/tabs with single space
    .replace(/\n{3,}/g, '\n\n') // Replace 3+ consecutive newlines with just 2
    .replace(/[ \t]+\n/g, '\n') // Remove spaces before newlines
    .replace(/\n[ \t]+/g, '\n') // Remove spaces after newlines
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
      //error badge
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
}

function addLoadingBadge(container: HTMLElement): void {
  console.log('add loading badge')

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

  // Add badge type
  const badgeType = document.createElement('span');
  badgeType.className = 'badge-type';
  badgeType.textContent = result.type || 'Normal';
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
