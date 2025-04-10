import { sendEmailContent, clearMessageHandlers } from './messageQueue';
import { AnalysisResult, EmailContent, newAnalysisResult, ResponseMessage } from './types';
import { getAnalyzedEmail, storeAnalyzedEmail, clearAnalyzedEmails } from './db';

// Keep WeakSets for processed elements and badge elements
let processedElements = new WeakSet<Element>();
let badgeElements = new WeakSet<Element>();

let lastRun: number = 0;
let throttleTimer: number | null = null;

// Add message listener for cache clearing
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'clearCache') {
    // Remove existing badges
    document.querySelectorAll('.email-safety-badge').forEach(badge => {
      badge.remove();
    });

    clearAnalyzedEmails().then(() => {
      processedElements = new WeakSet<Element>();
      badgeElements = new WeakSet<Element>();
      clearMessageHandlers();
      console.log('Email Safety Scanner: Cache and badges cleared');
      sendResponse({ success: true });
    }).catch(error => {
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
    subtree: true
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

function extractEmailContent(container: HTMLElement): EmailContent | null {
  const subject = container.querySelector('h2.hP')?.textContent ?? '';
  const body = container.querySelector('div.a3s.aiL')?.textContent ?? '';
  const sender = container.querySelector('span.gD')?.getAttribute('email') ?? '';
  const urls = Array.from(container.querySelectorAll('a')).map(a => a.href);

  return { subject, body, sender, urls };
}

async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
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
        confidence: response.confidence
      });
      
      // Store in IndexedDB instead of in-memory Map
      storeAnalyzedEmail(hash, analysisResult).then(() => {
        displayBadge(container, analysisResult);
      }).catch(error => {
        console.error('Failed to store analysis result:', error);
        // Still display badge even if storage fails
        displayBadge(container, analysisResult);
      });
    }
  });
}

function addLoadingBadge(container: HTMLElement): void {
  const loadingBadge = document.createElement('div');
  loadingBadge.className = 'email-safety-badge loading';
  
  const badgeIcon = document.createElement('div');
  badgeIcon.className = 'badge-icon';
  
  const spinner = document.createElement('i');
  spinner.className = 'fa fa-spinner fa-spin';
  
  badgeIcon.appendChild(spinner);
  loadingBadge.appendChild(badgeIcon);
  
  const subjectLine = container.querySelector('h2.hP');
  if (subjectLine) {
    if (subjectLine.querySelector('.email-safety-badge')) return;
    subjectLine.insertBefore(loadingBadge, subjectLine.firstChild);
  }
}

function displayBadge(container: HTMLElement, result: AnalysisResult): void {
  const existingBadge = container.querySelector('.email-safety-badge');
  if (existingBadge) {
    badgeElements.delete(existingBadge);
    existingBadge.remove();
  }

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

  // Insert badge at the start of the email subject line
  const subjectLine = container.querySelector('h2.hP');
  if (subjectLine) {
    //Remove existing badge if present
    subjectLine.querySelector('.email-safety-badge')?.remove();
    subjectLine.insertBefore(badge, subjectLine.firstChild);
  }
}