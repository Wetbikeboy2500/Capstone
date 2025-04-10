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

const systemPrompt = `You are an email security analysis assistant. Your task is to analyze the provided email content and determine if it poses any security threats.

INSTRUCTIONS:
1. Carefully examine the email's subject, body, sender, and any URLs.
2. Look for indicators of phishing, malware, scams, spam, data exfiltration attempts, or extortion.
3. Provide a brief analysis explaining your reasoning (30-50 words maximum).
4. Classify the email exactly as one of: safe, spam, unknown_threat, malware, data_exfiltration, phishing, scam, or extortion.
5. Assign a confidence score between 0 and 0.99, where 0.99 represents high confidence.

YOUR RESPONSE MUST BE VALID JSON IN THE FOLLOWING FORMAT:
{
  "brief_analysis": "Concise analysis",
  "type": "safe|spam|unknown_threat|malware|data_exfiltration|phishing|scam|extortion",
  "confidence": 0.XX
}

Do not include any other text in your response besides this JSON object.`;

export function newAnalysisResult(args: AnalysisResult): AnalysisResult {
  return { ...args };
}

export interface ProgressInput {
  loaded: number;
  total: number;
}