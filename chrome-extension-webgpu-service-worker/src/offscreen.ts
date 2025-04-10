import { Wllama } from '@wllama/wllama';
import { AnalysisResult, ProgressInput, RequestMessage } from './types';

// WLLAMA STATE
let wllama: Wllama | undefined;
let isModelLoaded = false;
let loadingPromise: Promise<null> | null = null;
let currentModelConfig: { n_ctx: number } | null = null;

// GBNF grammar for JSON output formatting
const jsonGrammar = `
root ::= "\`\`\`json" ws "{" ws "\\"brief_analysis\\":" ws string "," ws "\\"type\\":" ws threat "," ws "\\"confidence\\":" ws confidence ws "}" ws "\`\`\`"

threat ::= "\\"safe\\"" | "\\"spam\\"" | "\\"unknown_threat\\"" | "\\"malware\\"" | "\\"data_exfiltration\\"" | "\\"phishing\\"" | "\\"scam\\"" | "\\"extortion\\"" 

confidence ::= "0" | "0." [0-9]+ | "1" | "1.0"
string  ::= "\\"" ([^"\\\\] | "\\\\" ["\\\\bfnrt])* "\\""
ws      ::= [ \\t\\n]*
`;

// Configuration for wllama
const CONFIG_PATHS = {
  'single-thread/wllama.wasm': chrome.runtime.getURL('models/single-thread/wllama.wasm'),
  'multi-thread/wllama.wasm': chrome.runtime.getURL('models/multi-thread/wllama.wasm'),
};

const gemma3_1b = chrome.runtime.getURL('models/gemma-3-1b-it-q4_0_s-00001-of-00002.gguf');
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
 * Determines optimal model and parameters based on system resources
 */
async function getOptimalModelConfig() {
  // Default configuration for low-end devices
  let modelConfig = {
    modelName: 'gemma-3-4b-it-qat-q4_0-gguf',
    modelUrl: gemma3_4b,
    n_threads: 4,
    n_ctx: 4096,
    n_batch: 512,
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

    console.log(
      `System resources: ${cpuThreads} CPU threads, ${(availableRAMMB / 1024).toFixed(1)}GB available RAM of ${(
        totalRAMMB / 1024
      ).toFixed(1)}GB total`
    );

    // Same model selection logic as before...
    if (availableRAMMB >= 6000) {
      modelConfig = {
        modelName: 'gemma-3-4b-it-qat-q4_0-gguf',
        modelUrl: gemma3_4b,
        n_threads: Math.min(Math.max(2, Math.floor(cpuThreads * 0.5)), 6),
        n_ctx: Math.min(8192, Math.max(2048, Math.floor((availableRAMMB * 0.7 - 2360) / 0.5 / 512) * 512)),
        n_batch: Math.min(512, Math.max(256, Math.floor(modelConfig.n_ctx / 16))),
      };
    } else {
      modelConfig = {
        modelName: 'gemma-3-1b-it-qat-q4_0-gguf',
        modelUrl: gemma3_1b,
        n_threads: Math.min(Math.max(2, Math.floor(cpuThreads * 0.75)), 8),
        n_ctx: Math.min(8192, Math.max(2048, Math.floor((availableRAMMB * 0.7 - 720) / 0.15 / 512) * 512)),
        n_batch: Math.min(512, Math.max(256, Math.floor(modelConfig.n_ctx / 16))),
      };
    }

    console.log(
      `Selected ${modelConfig.modelName} with: ${modelConfig.n_threads} threads, ${modelConfig.n_ctx} context window, ${modelConfig.n_batch} batch size`
    );
  } catch (error) {
    console.warn('Error accessing system resources:', error);
    console.log('Using fallback configuration');
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

  let tokenCount = 0;

  try {
    const tokens = await wllama.tokenize(text);
    return tokens.length;
  } catch (error) {
    console.error('Offscreen: Error tokenizing input:', error);
    console.log('Offscreen: Attempting to tokenize in chunks');
    const chunkSize = 100;
    const chunks = text.match(new RegExp(`(.|\\s){1,${chunkSize}}`, 'g')) || [];
    for (const chunk of chunks) {
      try {
        console.log(chunk);
        const tokens = await wllama.tokenize(chunk);
        tokenCount += tokens.length;
      } catch (error) {
        console.error('Offscreen: Error tokenizing chunk:', error);
      }
    }
  }

  return tokenCount;
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

      // Use createCompletion with the prompt
      const completion = await wllama!.createChatCompletion(
        [
          {
            role: 'user',
            content: request.prompt,
          },
        ],
        {
          sampling: {
            temp: 1.0,
            top_k: 64,
            top_p: 0.95,
            min_p: 0.01,
            grammar: jsonGrammar,
          },
          onNewToken: (...args) => {
            console.log('Offscreen: New token:', args);
          },
        }
      );

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
