# Local AI Development & Ollama Guide

A comprehensive guide for running local LLMs and coding agents on an **Apple Silicon Mac (M4 Pro, 48 GB Unified Memory)** using **Ollama** and **Pi.dev**.

---

## Profiler

`bash system_profiler SPHardwareDataType SPDisplaysDataType | grep -E "Model Name|Chip|Processor|Total Number of Cores|Memory"`

## Hardware Profile & Memory Allocation

- **Machine:** MacBook Pro (Apple M4 Pro)
- **CPU / GPU:** 12-Core CPU / 16-Core GPU
- **Total Unified Memory:** 48 GB
- **Target VRAM Budget for LLMs:** ~35–36 GB (leaving ~12–13 GB for macOS & active applications)

---

## Recommended Models Matrix

| Model Identifier                      | Precision        | VRAM Footprint | Speed        | Primary Use Case                                                                                  |
| :------------------------------------ | :--------------- | :------------- | :----------- | :------------------------------------------------------------------------------------------------ |
| **`qwen2.5-coder:32b-instruct-q8_0`** | 8-bit (`Q8_0`)   | **~35 GB**     | ~12–16 tok/s | **Primary Coding Model:** Near-lossless precision for complex architecture & refactoring.         |
| **`qwen2.5-coder:32b`**               | 4-bit (`Q4_K_M`) | **~20 GB**     | ~20–25 tok/s | **Balanced Workhorse:** Fast 32B model leaving huge RAM overhead for large context windows.       |
| **`qwen2.5-coder:14b`**               | 4-bit (`Q4_K_M`) | **~9 GB**      | ~45–55 tok/s | **Ultra-Fast Subagent / Autocomplete:** Low fan noise, high speed for small scripts & unit tests. |
| **`deepseek-r1:32b`**                 | 4-bit (`Q4_K_M`) | **~20 GB**     | ~15–20 tok/s | **Deep Reasoning & Architecture:** Reasoning model for complex logic, algorithms, and planning.   |

---

## `package.json` Integration

Standard `package.json` files **do not allow standard JS inline comments** (`//` or `/* */`). To document your setup safely without breaking JSON parsing, use descriptive string keys or custom namespaces.

### Pasteable `package.json` Configuration

```json
{
    "name": "my-local-ai-project",
    "version": "1.0.0",
    "scripts": {
        "// --- MODEL RUNNERS ---": "Launch Ollama models in interactive CLI mode",
        "ollama:32b": "ollama run qwen2.5-coder:32b-instruct-q8_0",
        "ollama:32b:fast": "ollama run qwen2.5-coder:32b",
        "ollama:14b": "ollama run qwen2.5-coder:14b",
        "ollama:r1": "ollama run deepseek-r1:32b",

        "// --- MEMORY & PROCESS MANAGEMENT ---": "Monitor and control Ollama VRAM allocation",
        "ollama:ps": "ollama ps",
        "ollama:stop": "ollama stop qwen2.5-coder:32b-instruct-q8_0",
        "ollama:stop:all": "ollama ps | awk 'NR>1 {print $1}' | xargs -I {} ollama stop {}",
        "ollama:list": "ollama list",
        "ollama:serve": "ollama serve",

        "// --- PI HARNESS INTEGRATIONS ---": "Run Pi terminal agent attached to local or cloud models",
        "pi:32b": "pi --model ollama/qwen2.5-coder:32b-instruct-q8_0",
        "pi:14b": "pi --model ollama/qwen2.5-coder:14b",
        "pi:gemini": "pi --model google/gemini-2.5-flash"
    }
}
```

---

## Utility Command Reference

### Model Execution

```bash
# Run 8-bit Qwen Coder (High Precision)
npm run ollama:32b

# Run 4-bit Qwen Coder (Faster Execution)
npm run ollama:32b:fast

# Run DeepSeek-R1 (Reasoning)
npm run ollama:r1
```

### Memory Verification & Management

```bash
# Check currently loaded models and active VRAM usage
npm run ollama:ps

# Evict the 32B Q8 model immediately from VRAM (~35 GB freed)
npm run ollama:stop

# Stop ALL active models and clear all VRAM
npm run ollama:stop:all

# List all local models installed on disk
npm run ollama:list
```

### Pi.dev Terminal Harness Integration

```bash
# Launch Pi connected to your local 32B Q8 model
npm run pi:32b

# Launch Pi connected to Google Gemini Flash (Cloud Fallback)
npm run pi:gemini
```

---

## System Optimization for Apple Silicon

To ensure smooth performance and large context windows in terminal tools like `pi.dev`, set these environment variables in your shell configuration (`~/.zshrc`):

```bash
# Limit Ollama parallel model loading to keep VRAM focused on the active model
export OLLAMA_NUM_PARALLEL=1
export OLLAMA_MAX_LOADED_MODELS=1

# Extend default context window length for local models (e.g. 16k or 32k)
export OLLAMA_KEEP_ALIVE="5m"
```

> **Note on Memory:** Ollama will automatically unload inactive models after 5 minutes of idle time. Run `npm run ollama:stop` if you want to free VRAM immediately for heavy tasks like video editing, gaming, or compiling.
