export interface EmailContent {
  subject: string;
  body: string;
  sender: string;
  urls: string[];
}

export interface RequestMessage {
  requestType: 'request' | 'cancel';
  prompt: string;
  requestId: string;
}

export function newRequestMessage(args: RequestMessage): RequestMessage {
  return { ...args };
}

export interface ResponseMessage extends AnalysisResult {
  responseType: 'completion' | 'error';
  requestId: string;
}

export function newResponseMessage(args: ResponseMessage): ResponseMessage {
  return { ...args };
}

export interface AnalysisResult {
  brief_analysis: string;
  type: 'safe' | 'spam' | 'unknown_threat' | 'malware' | 'data_exfiltration' | 'phishing' | 'scam' | 'extortion' | 'error';
  confidence: number;
}

// System prompt to include with requests
export const SYSTEM_PROMPT = `Analyze email content (subject, body, sender, URLs) for security risks.
Output JSON containing:
1. brief_analysis: Concise reason for classification (max 75 chars).
2. type: One of 'safe', 'spam', 'unknown_threat', 'malware', 'data_exfiltration', 'phishing', 'scam', 'extortion'.
3. confidence: Score from 0.00 to 0.99.

Required JSON format: {"brief_analysis": "...", "type": "...", "confidence": 0.XX}`;

export function newAnalysisResult(args: AnalysisResult): AnalysisResult {
  return { ...args };
}

export interface ProgressInput {
  loaded: number;
  total: number;
}