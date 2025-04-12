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

confidence ::= "0" | "0." [0-9]{1,2} | "1" | "1.0"
string  ::= "\\"" ([^"\\\\] | "\\\\" ["\\\\bfnrt]){1,75} "\\""
ws      ::= [ \\t\\n]{0,2}
`;

// Configuration for wllama
const CONFIG_PATHS = {
  'single-thread/wllama.wasm': chrome.runtime.getURL('models/single-thread/wllama.wasm'),
  'multi-thread/wllama.wasm': chrome.runtime.getURL('models/multi-thread/wllama.wasm'),
};

const gemma3_4b = chrome.runtime.getURL('models/gemma-3-4b-it-q4_0_s-00001-of-00003.gguf');

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

function getMemoryAlignedValue(value: number): number {
  const alignment = 256;
  return Math.floor(value / alignment) * alignment;
}

/**
 * Determines optimal model parameters based on system resources
 */
async function getOptimalModelConfig() {
  // Set minimum memory requirements
  const baseModelSizeMB = 2989; // Base size of the 4b model in MB in memory
  const minContextSizeMB = 211; // Approximate memory needed for 2048 context size
  const safetyMarginMB = 512; // Safety margin for memory 
  const totalRequiredMB = baseModelSizeMB + minContextSizeMB + safetyMarginMB;

  try {
    // Request system information from background script
    const systemInfo = await chrome.runtime.sendMessage({ type: 'getSystemInfo' });
    const availableRAMMB = systemInfo?.availableRAMMB || 4096;
    const totalRAMMB = systemInfo?.totalRAMMB || 8192;
    const cpuThreads = systemInfo?.hardwareConcurrency || systemInfo?.cpuThreads || 4;

    console.log(
      `System resources: ${cpuThreads} CPU threads, ${(availableRAMMB / 1024).toFixed(1)}GB available RAM of ${(
        totalRAMMB / 1024
      ).toFixed(1)}GB total`
    );

    // Check if we have enough memory to run the model
    if (availableRAMMB < totalRequiredMB) {
      console.error(`Insufficient memory: need ${totalRequiredMB}MB but only have ${availableRAMMB}MB available`);
      // Notify background script of insufficient resources
      await chrome.runtime.sendMessage({
        type: 'insufficientResources',
        requiredRAMMB: totalRequiredMB,
        availableRAMMB: availableRAMMB
      });
      return null;
    }

    // Calculate context size based on available RAM with fallback values
    const tokenMemoryCostMB = 0.0978; // Approximate memory per token in MB
    
    // Calculate raw context size
    const calculatedCtx = Math.floor(((availableRAMMB - safetyMarginMB) - baseModelSizeMB) / tokenMemoryCostMB);
    
    // First apply memory alignment, then apply constraints
    const alignedCtx = getMemoryAlignedValue(calculatedCtx);
    const constrainedCtx = Math.max(2048, Math.min(alignedCtx, 9984));
    
    return {
      modelName: 'gemma-3-4b-it-qat-q4_0-gguf',
      modelUrl: gemma3_4b,
      n_threads: Math.max(2, Math.floor(cpuThreads * 0.75)),
      n_ctx: constrainedCtx,
      n_batch: 256,
    };
  } catch (error) {
    console.error('Error getting system info:', error);
    throw error;
  }
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
        
        // If modelConfig is null, we have insufficient resources
        if (!modelConfig) {
          throw new Error('Insufficient resources to load model');
        }
        
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
          cache_type_k: 'q8_0',
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
      const remainingTokens = contextSize - tokensToKeepForSystemPrompt;

      console.log(`Offscreen: Token count for input: ${tokens}`, `Remaining tokens for context: ${remainingTokens}`);

      if (remainingTokens <= 50) {
        return {
          brief_analysis:
            'The input text is too long to process reliably within the available context window. Unable to provide accurate threat assessment.',
          type: 'unknown_threat',
          confidence: 0.5,
        };
      }

      console.log('Offscreen: Starting inference');

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
        }
      );

      //Keep the main system prompt. This is not exact and just removes some of the looping needed by wllama
      wllama.kvRemove(tokensToKeepForSystemPrompt, -1);

      console.log('Offscreen: Inference completed', completion);
      getTokenCount(completion)
        .then((count) => console.log(`Offscreen: Token count for completion: ${count}`))
        .catch((error) => console.error('Offscreen: Error getting token count for completion:', error));

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