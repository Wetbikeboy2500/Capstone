import { Wllama } from '@wllama/wllama';
import { AnalysisResult, ProgressInput, RequestMessage, SYSTEM_PROMPT } from './types';

// WLLAMA STATE
let wllama: Wllama | undefined;
let isModelLoaded = false;
let loadingPromise: Promise<null> | null = null;
let currentModelConfig: { n_ctx: number } | null = null;
let tokensToKeepForSystemPrompt = 0;

// GBNF grammar for JSON output formatting
const jsonGrammar = `
root ::= "{" ws "\\"brief_analysis\\":" ws string "," ws "\\"type\\":" ws threat "," ws "\\"confidence\\":" ws confidence ws "}"

threat ::= "\\"safe\\"" | "\\"spam\\"" | "\\"unknown_threat\\"" | "\\"malware\\"" | "\\"data_exfiltration\\"" | "\\"phishing\\"" | "\\"scam\\"" | "\\"extortion\\"" 

confidence ::= "0" | "0." [0-9]+ | "1" | "1.0"
string  ::= "\\"" ([^"\\\\] | "\\\\" ["\\\\bfnrt]){1,50} "\\""
ws      ::= [ \\t\\n]{0,2}
`;

// Configuration for wllama
const CONFIG_PATHS = {
  'single-thread/wllama.wasm': chrome.runtime.getURL('models/single-thread/wllama.wasm'),
  'multi-thread/wllama.wasm': chrome.runtime.getURL('models/multi-thread/wllama.wasm'),
};

const gemma3_4b = chrome.runtime.getURL('models/gemma-3-4b-it-q4_0_s-00001-of-00006.gguf');

const progressCallback = ({ loaded, total }: ProgressInput) => {
  // Ensure we have valid numbers to prevent null or NaN percentages
  if (typeof loaded !== 'number' || typeof total !== 'number' || total <= 0) {
    console.log('Invalid progress values:', { loaded, total });
    return;
  }

  const progressPercentage = Math.round((loaded / total) * 100);
  console.log(`Downloading... ${progressPercentage}%`);

  // Report progress to service worker with validation
  chrome.runtime.sendMessage({
    type: 'modelLoadProgress',
    progressPercentage: isNaN(progressPercentage) ? 0 : progressPercentage,
  });
};

/**
 * Determines optimal model parameters based on system resources
 */
async function getOptimalModelConfig() {
  // Set base configuration for the 4b model with safe defaults
  let modelConfig = {
    modelName: 'gemma-3-4b-it-qat-q4_0-gguf',
    modelUrl: gemma3_4b,
    n_threads: 4,
    n_ctx: 4096,
    n_batch: 512,
  };

  /**
   * Returns a memory-aligned value that's close to the given number
   * Uses multiples of 256 which align well with memory representations
   */
  function getMemoryAlignedValue(n: number): number {
    // Use multiples of 256 for better memory alignment
    const aligned = Math.round(n / 256) * 256;
    // Ensure we have a valid positive number
    return Math.max(256, aligned || 4096); // Default to 4096 if calculation results in 0 or null
  }

  try {
    // Request system information from background script
    const systemInfo = await chrome.runtime.sendMessage({ type: 'getSystemInfo' });
    const availableRAMMB = systemInfo?.availableRAMMB || 8192; // Default to 8GB if null
    const totalRAMMB = systemInfo?.totalRAMMB || 16384; // Default to 16GB if null
    const cpuThreads = systemInfo?.hardwareConcurrency || systemInfo?.cpuThreads || 4; // Default to 4 if null

    console.log(
      `System resources: ${cpuThreads} CPU threads, ${(availableRAMMB / 1024).toFixed(1)}GB available RAM of ${(
        totalRAMMB / 1024
      ).toFixed(1)}GB total`
    );

    // Calculate context size based on available RAM with fallback values
    // Formula: (available RAM * safety factor - model base size) / token memory cost
    const baseModelSizeMB = 2360; // Base size of the 4b model in MB
    const tokenMemoryCostMB = 0.5; // Approximate memory per token in MB
    
    // Calculate raw context size
    const calculatedCtx = Math.floor((availableRAMMB * 0.7 - baseModelSizeMB) / tokenMemoryCostMB);
    
    // First apply memory alignment, then apply constraints
    const alignedCtx = getMemoryAlignedValue(calculatedCtx);
    const constrainedCtx = Math.min(8192, Math.max(2048, alignedCtx));
    
    // Calculate batch size - first raw value, then memory alignment
    const rawBatchSize = Math.floor(constrainedCtx / 16);
    const batchSize = getMemoryAlignedValue(rawBatchSize);
    // Apply constraints after alignment
    const constrainedBatchSize = Math.min(512, Math.max(256, batchSize));
    
    modelConfig = {
      modelName: 'gemma-3-4b-it-qat-q4_0-gguf',
      modelUrl: gemma3_4b,
      n_threads: Math.max(2, Math.floor(cpuThreads * 0.75)),
      n_ctx: constrainedCtx,
      n_batch: constrainedBatchSize,
    };
    
    console.log(`Selected context size: ${constrainedCtx}, batch size: ${constrainedBatchSize}`);
  } catch (error) {
    console.error('Error getting system info:', error);
    // Fall through to use default values if we can't get system info
  }

  return modelConfig;
}

// Initialize wllama in the offscreen document
async function initializeWllama(): Promise<void> {
  if (isModelLoaded) {
    return;
  }

  if (loadingPromise) {
    await loadingPromise;
    return;
  }

  try {
    console.log('Offscreen: Initializing Wllama');
    loadingPromise = new Promise(async (resolve, reject) => {
      try {
        wllama = new Wllama(CONFIG_PATHS, {
          allowOffline: true,
          parallelDownloads: 6,
          logger: {
            debug: (msg: string) => console.log('Offscreen: Wllama debug:', msg),
            log: (msg: string) => console.log('Offscreen: Wllama info:', msg),
            warn: (msg: string) => console.warn('Offscreen: Wllama warn:', msg),
            error: (msg: string) => console.error('Offscreen: Wllama error:', msg),
          }
        });

        // Get optimal model configuration
        const modelConfig = await getOptimalModelConfig();
        currentModelConfig = modelConfig; // Store for later reference

        console.log(`Loading model ${modelConfig.modelName} with parameters:`, {
          n_threads: modelConfig.n_threads,
          n_ctx: modelConfig.n_ctx,
          n_batch: modelConfig.n_batch,
          modelUrl: modelConfig.modelUrl,
        });

        await wllama.loadModelFromUrl(modelConfig.modelUrl, {
          n_threads: modelConfig.n_threads,
          n_ctx: modelConfig.n_ctx,
          n_batch: modelConfig.n_batch,
          progressCallback,
        });

        resolve(null);
      } catch (e) {
        console.error('Offscreen: Error loading model', e);
        reject(e);
      }
    });

    await loadingPromise;
    isModelLoaded = true;
    tokensToKeepForSystemPrompt = await getTokenCount(SYSTEM_PROMPT);
    console.log('Offscreen: Wllama initialized');

    // Notify service worker that model is ready
    chrome.runtime.sendMessage({
      type: 'modelLoaded',
      contextSize: currentModelConfig?.n_ctx,
    });
  } catch (error) {
    console.error('Offscreen: Error initializing Wllama:', error);
    isModelLoaded = false;

    // Notify service worker of failure
    chrome.runtime.sendMessage({
      type: 'modelLoadError',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Gets accurate token count from input text using the model's tokenizer
 * Handles inputs that exceed context length by breaking them into smaller chunks
 */
async function getTokenCount(text: string): Promise<number> {
  if (!wllama || !isModelLoaded) {
    throw new Error('Model not loaded');
  }

  const tokens = await wllama.tokenize(text, false);
  return tokens.length;
}

/**
 * Processes a single inference request
 */
async function processInference(request: RequestMessage): Promise<any> {
  const maxRetries = 1;
  let retryCount = 0;

  async function attemptInference() {
    try {
      if (!wllama || !isModelLoaded) {
        throw new Error('Model not loaded');
      }

      console.log('Offscreen: Getting token count');

      // Check if input is likely to exceed context window
      const contextSize = currentModelConfig?.n_ctx || 4096;
      const tokens = await getTokenCount(request.prompt);
      const effectiveContextSize = Math.floor(contextSize * 0.8);

      console.log(`Offscreen: Token count for input: ${tokens} (max: ${effectiveContextSize} of ${contextSize})`);

      if (tokens > effectiveContextSize) {
        return {
          brief_analysis:
            'The input text is too long to process reliably within the available context window. Unable to provide accurate threat assessment.',
          type: 'unknown_threat',
          confidence: 0.5,
        };
      }

      console.log('Offscreen: Starting inference');
      let start = new Date();

      const prompt = await wllama.formatChat([
        {
          role: 'user',
          content: request.prompt,
        },
      ], true);

      // Use createCompletion with the prompt
      const completion = await wllama!.createCompletion(
        prompt,
        {
          sampling: {
            temp: 1.0,
            top_k: 64,
            top_p: 0.95,
            min_p: 0.01,
            grammar: jsonGrammar,
          },
          useCache: true,
          onNewToken: (...args) => {
            console.log('Offscreen: Time to token:', new Date().getTime() - start.getTime(), 'ms', args);
            start = new Date();
          },
        }
      );

      //Keep the main system prompt. This is not exact and just removes some of the looping needed by wllama
      wllama.kvRemove(tokensToKeepForSystemPrompt, -1);

      console.log('Offscreen: Inference completed', completion);

      return JSON.parse(completion) as AnalysisResult;
    } catch (error) {
      console.error('Offscreen: Error during inference:', error);

      // Handle context overflow specifically
      if (
        error instanceof Error &&
        (error.message.includes('context') ||
          error.message.includes('token') ||
          error.message.includes('overflow') ||
          error.message.includes('size'))
      ) {
        return {
          brief_analysis:
            'Analysis failed due to context window limitations. The input might be too complex or contain too many tokens to analyze properly.',
          type: 'unknown_threat',
          confidence: 0.5,
        };
      }

      throw error; // Re-throw for general error handling
    }
  }

  // First attempt
  try {
    return await attemptInference();
  } catch (error) {
    // Retry once if there's an error
    if (retryCount < maxRetries) {
      console.log(`Retrying inference (attempt ${retryCount + 1} of ${maxRetries + 1})`);
      retryCount++;
      return await attemptInference();
    }

    // If we've reached max retries, propagate the error
    throw error;
  }
}

// Set up message handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('Offscreen: Received message', message);

  if (message.type === 'initialize') {
    // Initialize the model
    initializeWllama()
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true; // Indicate async response
  }

  if (message.type === 'inference') {
    // Process the inference request
    processInference(message.request)
      .then((result) => sendResponse({ success: true, result }))
      .catch((error) =>
        sendResponse({
          success: false,
          error: String(error),
          result: {
            brief_analysis: 'An error occurred during analysis: ' + String(error),
            type: 'unknown_threat',
            confidence: 0,
          },
        })
      );
    return true; // Indicate async response
  }

  if (message.type === 'getTokenCount') {
    if (!wllama || !isModelLoaded) {
      sendResponse({ success: false, error: 'Model not loaded' });
      return true;
    }

    getTokenCount(message.text)
      .then((count) => sendResponse({ success: true, tokenCount: count }))
      .catch((error) => sendResponse({ success: false, error: String(error) }));
    return true; // Indicate async response
  }
});

// Begin initialization when the document loads
document.addEventListener('DOMContentLoaded', () => {
  console.log('Offscreen document loaded');
});
