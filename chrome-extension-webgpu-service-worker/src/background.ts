/// <reference types="@webgpu/types" />
import { Wllama } from '@wllama/wllama';
import { ProgressInput, RequestMessage, AnalysisResult, newResponseMessage } from './types';

// Define wllama instance and handler
let wllama: Wllama | undefined;
let isModelLoaded = false;
const MAX_CONCURRENT_REQUESTS = 3; // Maximum number of concurrent requests
let activeRequestsCount = 0;
let requestsQueue: { message: RequestMessage, port: chrome.runtime.Port }[] = [];
// Store the current model configuration
let currentModelConfig: { n_ctx: number } | null = null;

// GBNF grammar for JSON output formatting
const jsonGrammar = `
root ::= "{" ws
    "\\"brief_analysis\\":" ws string "," ws
    "\\"type\\":" ws threat "," ws
    "\\"confidence\\":" ws confidence
    ws "}"

threat ::= "\\"safe\\"" | "\\"spam\\"" | "\\"unknown_threat\\"" | "\\"malware\\"" | "\\"data_exfiltration\\"" | "\\"phishing\\"" | "\\"scam\\"" | "\\"extortion\\"" 

confidence ::= "0" | "0." [0-9]+ | "1" | "1.0"
string  ::= "\\"" ([^"\\\\] | "\\\\" ["\\\\bfnrt])* "\\""
ws      ::= [ \\t\\n]*
`;

// Configuration for wllama
const CONFIG_PATHS = {
  'single-thread/wllama.wasm': chrome.runtime.getURL('wllama/single-thread/wllama.wasm'),
  'multi-thread/wllama.wasm': chrome.runtime.getURL('wllama/multi-thread/wllama.wasm'),
};

const progressCallback = ({ loaded, total }: ProgressInput) => {
   const progressPercentage = Math.round((loaded / total) * 100);
   console.log(`Downloading... ${progressPercentage}%`);
};

let loadingPromise: Promise<null> | null = null;

/**
 * Determines optimal model and parameters based on system resources
 * Uses Chrome system.memory and system.cpu APIs to get accurate readings
 */
async function getOptimalModelConfig() {
  // Default configuration for low-end devices
  let modelConfig = {
    modelRepo: 'google/gemma3',
    modelName: 'gemma-3-4b-it-qat-q4_0-gguf',
    n_threads: 4,
    n_ctx: 4096,
    n_batch: 512
  };
  
  try {
    // Request memory info
    // @ts-ignore - Using Chrome extension API not in TypeScript defs
    const memoryInfo = await chrome.system.memory.getInfo();
    const availableRAMMB = memoryInfo.availableCapacity / (1024 * 1024);
    const totalRAMMB = memoryInfo.capacity / (1024 * 1024);
    
    // Request CPU info
    // @ts-ignore - Using Chrome extension API not in TypeScript defs
    const cpuInfo = await chrome.system.cpu.getInfo();
    const cpuThreads = cpuInfo.numOfProcessors || 4;
    
    console.log(`System resources: ${cpuThreads} CPU threads, ${(availableRAMMB/1024).toFixed(1)}GB available RAM of ${(totalRAMMB/1024).toFixed(1)}GB total`);
    
    // Calculate optimal context size considering:
    // 1. Model size (4B = ~2360MB, 1B = ~720MB)
    // 2. Memory needed for KV cache
    // 3. Browser overhead
    // 4. Token-to-memory ratio (varies by model size)

    // Determine which model to use based on available memory
    let modelSizeMB = 0;
    let tokenMemoryRatio = 0;
    let maxContextWindow = 0;
    let modelName = '';
    
    if (availableRAMMB >= 6000) {  // At least 6GB available
      // 4B model
      modelSizeMB = 2360;  // 2.36GB for 4B model
      tokenMemoryRatio = 0.5;  // ~0.5MB per token for KV cache (simplified)
      maxContextWindow = 8192;
      modelName = 'gemma-3-4b-it-qat-q4_0-gguf';
    } else {
      // 1B model
      modelSizeMB = 720;  // 720MB for 1B model
      tokenMemoryRatio = 0.15;  // ~0.15MB per token for KV cache (simplified)
      maxContextWindow = 8192;
      modelName = 'gemma-3-1b-it-qat-q4_0-gguf';
    }
    
    // Reserve memory for browser and system overhead (30% of available)
    const reservedMemoryMB = availableRAMMB * 0.3;
    
    // Remaining memory for model + KV cache
    const usableMemoryMB = availableRAMMB - reservedMemoryMB;
    
    // Memory available for KV cache after loading model
    const kvCacheMemoryMB = Math.max(0, usableMemoryMB - modelSizeMB);
    
    // Calculate maximum possible context size based on available memory
    // This scales linearly with available memory after accounting for the model size
    const memoryBasedContextSize = Math.floor(kvCacheMemoryMB / tokenMemoryRatio);
    
    // Get optimal context size capped by model limitations
    // Round to nearest 512 for better alignment with internal buffers
    const optimalContextSize = Math.min(
      maxContextWindow,
      Math.max(2048, Math.floor(memoryBasedContextSize / 512) * 512)
    );
    
    // Calculate optimal thread count based on available CPU threads
    const optimalThreads = Math.min(
      Math.max(2, Math.floor(cpuThreads * (modelName.includes('4b') ? 0.5 : 0.75))),
      modelName.includes('4b') ? 6 : 8
    );
    
    // Calculate optimal batch size based on context size
    // Larger contexts benefit from larger batches, but too large can cause memory issues
    const optimalBatchSize = Math.min(
      512,
      Math.max(256, Math.floor(optimalContextSize / 16))
    );
    
    modelConfig = {
      modelRepo: 'google/gemma3',
      modelName: modelName,
      n_threads: optimalThreads,
      n_ctx: optimalContextSize,
      n_batch: optimalBatchSize
    };
    
    console.log(`Memory-based context calculation: ${memoryBasedContextSize} tokens (${kvCacheMemoryMB.toFixed(0)}MB KV cache memory)`);
    console.log(`Selected ${modelConfig.modelName} with: ${modelConfig.n_threads} threads, ${modelConfig.n_ctx} context window, ${modelConfig.n_batch} batch size`);
  } catch (error) {
    console.warn('Error accessing system resources:', error);
    console.log('Using fallback configuration for Gemma3 1B model');
  }
  
  return modelConfig;
}

// Initialize wllama in background
async function initializeWllama(): Promise<void> {
  if (isModelLoaded) {
    return;
  }
  
  if (loadingPromise) {
    await loadingPromise;
    return;
  }

  try {
    console.log('ServiceWorker: Initializing Wllama');
    loadingPromise = new Promise(async (resolve, reject) => {
      try {
        wllama = new Wllama(
          CONFIG_PATHS,
          {
            allowOffline: true,
          }
        );

        // Get optimal model configuration using the simplified function
        const modelConfig = await getOptimalModelConfig();
        currentModelConfig = modelConfig; // Store for later reference
    
        console.log(`Loading model ${modelConfig.modelRepo}/${modelConfig.modelName} with parameters:`, { 
          n_threads: modelConfig.n_threads, 
          n_ctx: modelConfig.n_ctx, 
          n_batch: modelConfig.n_batch 
        });
        
        await wllama.loadModelFromHF(
          modelConfig.modelRepo,
          modelConfig.modelName,
          {
            n_threads: modelConfig.n_threads,
            n_ctx: modelConfig.n_ctx,
            n_batch: modelConfig.n_batch,
            progressCallback,
          }
        );
  
        resolve(null);
      } catch (e) {
        console.error(e);
        reject();
      }
    });

    await loadingPromise;
    isModelLoaded = true;
    console.log('ServiceWorker: Wllama initialized');
  } catch (error) {
    console.error('ServiceWorker: Error initializing Wllama:', error);
    isModelLoaded = false;
  }
}

// Start initializing wllama as soon as the service worker starts
initializeWllama();

// Process requests from queue
function processQueue() {
  if (requestsQueue.length === 0 || activeRequestsCount >= MAX_CONCURRENT_REQUESTS) {
    return;
  }
  
  while (activeRequestsCount < MAX_CONCURRENT_REQUESTS && requestsQueue.length > 0) {
    const nextRequest = requestsQueue.shift();
    if (nextRequest) {
      activeRequestsCount++;
      processRequest(nextRequest.message, nextRequest.port)
        .finally(() => {
          activeRequestsCount--;
          // Try to process more requests
          setTimeout(processQueue, 0);
        });
    }
  }
}

/**
 * Gets accurate token count from input text using the model's tokenizer
 */
async function getTokenCount(text: string): Promise<number> {
  // wllama should always be available at this point
  const tokens = await wllama!.tokenize(text);
  return tokens.length;
}

/**
 * Checks if input is likely to exceed context window
 */
async function willExceedContextWindow(text: string, contextSize: number): Promise<boolean> {
  const tokenCount = await getTokenCount(text);
  
  // Consider that we need tokens for both input and output
  // Reserve ~20% of context for output and model overhead
  const effectiveContextSize = Math.floor(contextSize * 0.8);
  
  console.log(`Token count for input: ${tokenCount} (max: ${effectiveContextSize} of ${contextSize})`);
  
  return tokenCount > effectiveContextSize;
}

// Process a single request
async function processRequest(message: RequestMessage, port: chrome.runtime.Port): Promise<void> {
  if (!wllama || !isModelLoaded) {
    try {
      await initializeWllama();
    } catch (error) {
      sendErrorResponse(port, message.requestId, 'Failed to initialize model');
      return;
    }
  }
  
  try {
    console.log('ServiceWorker: Processing request', message.requestId);
    
    // Check if input is likely to exceed context window
    // Use the stored context size from model configuration
    const contextSize = currentModelConfig?.n_ctx || 4096; // Fallback to 4096 if not set
    if (await willExceedContextWindow(message.prompt, contextSize)) {
      console.warn(`Input likely to exceed context window (${contextSize} tokens)`);
      
      const result: AnalysisResult = {
        brief_analysis: "The input text is too long to process reliably within the available context window. Unable to provide accurate threat assessment.",
        type: "unknown_threat",
        confidence: 0.5
      };
      
      const response = newResponseMessage({
        responseType: 'completion',
        requestId: message.requestId,
        ...result,
      });
      
      port.postMessage(response);
      return;
    }
    
    // Use createCompletion with the combined prompt from messageQueue
    const completion = await wllama!.createCompletion(message.prompt, {
      sampling: {
        temp: 1.0,
        top_k: 64,
        top_p: 0.95,
        min_p: 0.01,
        grammar: jsonGrammar,
      }
    });

    const result = JSON.parse(completion) as AnalysisResult;
    const response = newResponseMessage({
      responseType: 'completion',
      requestId: message.requestId,
      ...result,
    });
    
    port.postMessage(response);
  } catch (error: unknown) {
    // Check if the error might be related to context overflow
    if (error instanceof Error && 
        (error.message.includes("context") || 
         error.message.includes("token") || 
         error.message.includes("overflow") || 
         error.message.includes("size"))) {
      
      const contextOverflowResult: AnalysisResult = {
        brief_analysis: "Analysis failed due to context window limitations. The input might be too complex or contain too many tokens to analyze properly.",
        type: "unknown_threat",
        confidence: 0.5
      };
      
      port.postMessage(newResponseMessage({
        responseType: 'completion',
        requestId: message.requestId,
        ...contextOverflowResult,
      }));
    } else {
      sendErrorResponse(port, message.requestId, error);
    }
  }
}

function sendErrorResponse(port: chrome.runtime.Port, requestId: string, error: unknown) {
  console.error('ServiceWorker: Error processing message', error);
  port.postMessage({
    responseType: 'error',
    error: error instanceof Error ? error.toString() : 'Unknown error occurred',
    requestId: requestId,
    brief_analysis: error instanceof Error ? error.message : 'Unknown error occurred',
    type: 'unknown_threat',
    confidence: 0
  });
}

// Create message handler for processing requests
async function handleMessage(message: RequestMessage, port: chrome.runtime.Port): Promise<void> {
  console.log('ServiceWorker: Received message', message);
  
  // Add to queue
  requestsQueue.push({ message, port });
  
  // Try to process the queue
  processQueue();
}

// Set up port connection listener
chrome.runtime.onConnect.addListener(function (port: chrome.runtime.Port): void {
  console.log('ServiceWorker: New port connection');
  console.assert(port.name === "web_llm_service_worker");
  
  // Listen for messages
  port.onMessage.addListener((message: RequestMessage) => handleMessage(message, port));
});