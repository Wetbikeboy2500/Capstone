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
  type: 'safe' | 'spam' | 'unknown_threat' | 'malware' | 'data_exfiltration' | 'phishing' | 'scam' | 'extortion';
  confidence: number;
}

// System prompt to include with requests
export const SYSTEM_PROMPT = `Evaluate email security risks based on content analysis.

INSTRUCTIONS:
1. Review the email's subject, body, sender, and URLs
2. Assess for potential security concerns
3. Provide brief reasoning (1-50 chars)
4. Classify as one of: safe, spam, unknown_threat, malware, data_exfiltration, phishing, scam, or extortion
5. Include confidence score (0-0.99)

RESPONSE FORMAT (JSON only):
{
  "brief_analysis": "Concise analysis",
  "type": "safe|spam|unknown_threat|malware|data_exfiltration|phishing|scam|extortion",
  "confidence": 0.XX
}`;

export function newAnalysisResult(args: AnalysisResult): AnalysisResult {
  return { ...args };
}

export interface ProgressInput {
  loaded: number;
  total: number;
}