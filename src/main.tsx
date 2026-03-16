import React from "react";
import ReactDOMClient from "react-dom/client";

type PusherConstructor = typeof import("pusher-js").default;
import { Options, TAgentLoop, TAgentJob, TAskJob, TAskToRigobot, TCompleteWithRigo, TUseTemplateWithRigo, toolify, TTool, TRunAgent } from "./types.ts";
import { generateRandomId, logger, convertToHTML } from "./utils/utilities.ts";
import { Rigobot } from "./components/Rigobot/Rigobot.tsx";

import packageJson from "../package.json";

import io from "socket.io-client";

function wait(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

declare global {
  interface Window {
    Pusher?: PusherConstructor;
    __rigoPusherPromise?: Promise<PusherConstructor>;
  }
}

async function loadPusher(): Promise<PusherConstructor> {
  if (typeof window === "undefined") {
    throw new Error("Pusher can only be loaded in the browser");
  }

  if (window.Pusher) {
    return window.Pusher;
  }

  if (window.__rigoPusherPromise) {
    return window.__rigoPusherPromise;
  }

  window.__rigoPusherPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[data-rigo="pusher"]');

    if (existingScript) {
      existingScript.addEventListener("load", () => {
        if (window.Pusher) {
          resolve(window.Pusher!);
        } else {
          reject(new Error("Pusher failed to load"));
        }
      });

      existingScript.addEventListener("error", () => {
        reject(new Error("Failed to load existing Pusher script"));
      });

      return;
    }

    const script = document.createElement("script");
    script.src = "https://js.pusher.com/7.6.0/pusher.min.js";
    script.async = true;
    script.dataset.rigo = "pusher";

    script.onload = () => {
      if (window.Pusher) {
        resolve(window.Pusher!);
      } else {
        reject(new Error("Pusher global not available after script load"));
      }
    };

    script.onerror = () => {
      reject(new Error("Failed to load Pusher script"));
    };

    document.head.appendChild(script);
  });

  window.__rigoPusherPromise.catch(() => {
    window.__rigoPusherPromise = undefined;
  });

  return window.__rigoPusherPromise;
}

interface Rigo {
  init: (token: string, options?: Options) => void;
  show: (params: Options) => void;
  hide: () => void;
  ask: (TAskToRigobot: TAskToRigobot) => TAskJob | undefined;
  complete: (TCompleteWithRigo: TCompleteWithRigo) => void;
  use_template: (TUseTemplateWithRigo: TUseTemplateWithRigo) => TAskJob | undefined;
  agentLoop: (params: TAgentLoop) => TAgentJob;
  agent: (params: TRunAgent) => TAgentJob;
  // stopGeneration: () => void;
  on: (event: string, callback: (data: any) => void) => void;
  updateOptions: (newOptions: Options) => void;
  convertTool: (func: any, name: string, description: string, parameters: any) => TTool;

  callbacks: {
    [key: string]: (data: any) => void;
  };
  // callbackDescriptions: {
  //   [key: string]: string;
  // };
  container?: HTMLElement;
  options?: Options;
  token?: string;
  root?: ReactDOMClient.Root;
  version?: string;
}

declare global {
  interface Window {
    rigo: Rigo;
  }
}

const validFormats = ["html", "markdown"];

window.rigo = {
  init: function (token, options = {}) {
    let loglevel = "info";
    if (options.loglevel) {
      loglevel = options.loglevel;
    }
    logger.init(loglevel);

    logger.info("Initializing Rigobot!");
    const container = document.createElement("div");
    document.body.appendChild(container);

    this.container = container;
    this.options = options;
    this.token = token;
  },
  show: function (showOpts) {
    if (this.container) {
      const options = {
        ...this.options,
        ...showOpts,
        collapsed:
          typeof showOpts.collapsed === "boolean" ? showOpts.collapsed : true,
      };

      this.options = options;

      console.log("Showing Rigobot with options: ", options);

      if (!this.root) {
        this.root = ReactDOMClient.createRoot(this.container);
      }
      this.root.render(
        <React.StrictMode>
          <Rigobot chatAgentHash={this.token!} options={this.options} />
        </React.StrictMode>
      );
      logger.info("Calling show method", "Rigobot is active!");
      return "Now Rigobot is active!";
    } else {
      logger.error(
        "You must call the rigo.init method before attempting to show the chat."
      );
    }
  },
  hide: function () {
    logger.debug("Hiding Rigobot");
    if (this.root) {
      this.root.unmount();
      logger.info("React DOM removed!");
    } else {
      logger.debug("Impossible to hide, a React root was not found!");
    }
  },
  on: function (event: string, callback: (data: any) => void) {
    this.callbacks[event] = callback;
  },
  callbacks: {},
  ask: function ({
    prompt,
    target,
    previousMessages = [],
    useVectorStore = true,
    format = "markdown",
    // stream = false,
    onComplete,
    onStart,
    onStream,
  }: TAskToRigobot) {
    logger.debug("Asking Rigobot a question");

    if (!this.options?.purposeSlug) {
      logger.error(
        "No purpose slug provided, call rigo.init first and provide a purposeSlug"
      );
      onComplete?.(false, { error: "No purpose slug provided" });
      return;
    }

    if (!this.token) {
      logger.error(
        "No token provided, call rigo.init first and provide a token"
      );
      onComplete?.(false, { error: "No token provided" });
      return;
    }

    if (!prompt) {
      logger.error("No prompt provided");
      onComplete?.(false, { error: "No prompt provided" });
      return;
    }

    let temporalSocket = io(
      this.options?.socketHost ?? "https://ai.4geeks.com", 
      {
        autoConnect: true,
        transports: ["websocket", "polling"],
      }
    );

    const jobId = generateRandomId();
    let started = false;

    if (!target && !onComplete) {
      logger.error(
        "No target or onComplete provided, please set one of them to use the ask method"
      );
      return;
    }

    if (target && !(target instanceof HTMLElement)) {
      const eMessage = "Target is not an HTMLElement";
      console.log(target);

      logger.error(eMessage);
      onComplete?.(false, { error: eMessage });
      return;
    }

    temporalSocket?.on(`answer-stream-${jobId}`, (data: any) => {
      if (!started) {
        onStart?.({
          when: new Date().toISOString(),
          url: window.location.href,
        });
        started = true;
      }

      if (target && format === "markdown") {
        target.innerHTML += data.chunk;
      } else if (target && format === "html") {
        target.innerHTML = convertToHTML(data.cumulative);
      } else {
        logger.error("Target is not an HTMLElement or format is not supported");
      }

      onStream?.({
        chunk: data.chunk,
        cumulative: data.cumulative,
      });
    });

    temporalSocket?.on(`answer-stream-end-${jobId}`, (data: any) => {
      onComplete?.(true, data);
      temporalSocket?.disconnect();
    });

    const job: TAskJob = {
      stop: () => {
        temporalSocket?.off(`answer-stream-end-${jobId}`);
        temporalSocket?.off(`answer-stream-${jobId}`);
        temporalSocket?.disconnect();
      },

      run: () => {
        temporalSocket?.emit("ask", {
          jobId,
          message: {
            text: prompt,
            image: null,
          },
          // stream: stream,

          purpose: {
            slug: this.options?.purposeSlug,
            id: this.options?.purposeId,
          },
          context: {
            extra: this.options?.context,
            previousMessages: previousMessages,
            useVectorStore: useVectorStore,
          },
          auth: {
            token: this.token,
          },
        });
      },
    };

    return job;
  },
  agentLoop: function ({
    task,
    context,
    tools,
    onMessage,
    onComplete,
  }: TAgentLoop): TAgentJob {
    logger.debug("Starting agent loop with task: ", task);

    if (!task) {
      logger.error("No task provided");
      throw new Error("No task provided");
    }

    if (!this.token) {
      logger.error(
        "No token provided, call rigo.init first and provide a token"
      )
      throw new Error("No token provided");
    }

    let temporalSocket = io(
      this.options?.socketHost ?? "https://ai.4geeks.com",
      {
        autoConnect: true,
        transports: ["websocket", "polling"],
      }
    );

    // Handle agent waiting for tools
    temporalSocket?.on("tool-call", async (data: any, ack: any) => {
      logger.debug("Agent is executing tools: ", data)
      let result = []
      for (const tool of data.tool_calls) {
        // find the tool to call
        const toolToCall = tools.find((t) => t.schema.function.name === tool.function.name);
        if (toolToCall) {
          const response = await toolToCall.function(JSON.parse(tool.function.arguments));
          result.push({
            tool_call_id: tool.id,
            name: tool.function.name,
            output: response
          });
        }
      }
      ack(result);
    });

    temporalSocket?.on("assistant-message", (data: any) => {
      logger.info("Assistant message: ", data);
      onMessage?.(data.message);
    });
    // Handle agent completion
    temporalSocket?.on("agent-loop-completed", (data: any) => {
      logger.info("Agent loop completed: ", data);
      onComplete?.(data.status === "SUCCESS", data);
      temporalSocket?.disconnect();
    });
    temporalSocket.on("agent-loop-started", (data, ack) => {
      logger.debug("Agent loop started: ", data);
      if (ack) ack(true);
    });

    return {
      stop: () => {
        temporalSocket?.off("tool-call");
        temporalSocket?.off("assistant-message");
        temporalSocket?.off("agent-loop-completed");
        temporalSocket?.off("agent-loop-started");
        temporalSocket?.disconnect();
      },

      run: () => {
        temporalSocket.on("connect", () => {
          logger.debug("Starting agent loop", tools);
          temporalSocket?.emit("start_agent_loop", {
            task,
            tools: tools.map((tool) => tool.schema),
            context,
            purpose: {
              slug: this.options?.purposeSlug,
              id: this.options?.purposeId,
            },
            token: this.token,
          });
        });
        temporalSocket.connect();
      },
    }
  },

  agent: function ({
    slug,
    payload = {},
    onEvent,
    onComplete,
  }: TRunAgent): TAgentJob {
    if (!slug) {
      const error = "No agent slug provided";
      logger.error(error);
      onEvent?.({ type: "error", data: { error, m: error } });
      onComplete?.(false, { error });
      return { stop: () => {}, run: () => {} };
    }

    const apiHost = (this.options?.apiHost ?? "https://rigobot.herokuapp.com").replace(/\/+$/, "");

    // This endpoint requires an authenticated user token (Authorization: Token ...)
    const userToken = this.options?.user?.token ?? this.token;
    if (!userToken) {
      const error = "No token provided. Set rigo.init(token) or options.user.token";
      logger.error(error);
      onEvent?.({ type: "error", data: { error, m: error } });
      onComplete?.(false, { error });
      return { stop: () => {}, run: () => {} };
    }

    const soketiKey = import.meta.env.VITE_SOKETI_KEY;
    const soketiHost = import.meta.env.VITE_SOKETI_HOST;
    const soketiPort = import.meta.env.VITE_SOKETI_PORT;
    if (!soketiKey || !soketiHost || !soketiPort) {
      const error = "Missing Soketi config. Provide VITE_SOKETI_KEY, VITE_SOKETI_HOST and VITE_SOKETI_PORT";
      logger.error(error);
      onEvent?.({ type: "error", data: { error, m: error } });
      onComplete?.(false, { error });
      return { stop: () => {}, run: () => {} };
    }

    const endpoint = `${apiHost}/v2/learnpack/agent/${encodeURIComponent(slug)}/`;

    let pusher: any | undefined;
    let channel: any | undefined;
    let isStopped = false;

    const stop = () => {
      isStopped = true;
      try {
        if (channel) {
          channel.unbind_all();
          channel.unsubscribe();
        }
      } catch (e) {
        // noop
      }
      try {
        pusher?.disconnect?.();
      } catch (e) {
        // noop
      }
    };

    const run = () => {
      void (async () => {
        try {
          const resp = await fetch(endpoint, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Token ${userToken}`,
            },
            body: JSON.stringify(payload ?? {}),
          });

          const data = await resp.json().catch(() => ({}));
          if (!resp.ok) {
            const error = (data && (data.detail || data.error || data.message)) || `Agent request failed (${resp.status})`;
            throw new Error(typeof error === "string" ? error : "Agent request failed");
          }

          const agentRunUrl = data?.agent_run;
          if (!agentRunUrl || typeof agentRunUrl !== "string") {
            throw new Error("Missing agent_run in response");
          }

          const extraFromStart = (data && typeof data === "object") ? data.extra : undefined;

          const match = agentRunUrl.match(/agent-run\/([0-9a-f-]{36})/i);
          const runId = match?.[1];
          if (!runId) {
            throw new Error("Could not extract run_id from agent_run URL");
          }

          const fetchAgentRunDetail = async () => {
            // Prefer the URL returned by the API, but fall back to v2 if needed.
            const tryUrls = [
              agentRunUrl,
              `${apiHost}/v2/prompting/agent/run/${runId}/`,
            ];

            let lastError: any = null;
            for (const url of tryUrls) {
              try {
                const r = await fetch(url, {
                  method: "GET",
                  headers: {
                    Authorization: `Token ${userToken}`,
                  },
                });

                const j = await r.json().catch(() => ({}));
                if (!r.ok) {
                  const msg =
                    (j && (j.detail || j.error || j.message)) ||
                    `Failed to fetch agent run (${r.status})`;
                  throw new Error(typeof msg === "string" ? msg : "Failed to fetch agent run");
                }

                return j;
              } catch (e) {
                lastError = e;
              }
            }

            throw lastError || new Error("Failed to fetch agent run");
          };

          let agentRunDetail: any = undefined;
          try {
            agentRunDetail = await fetchAgentRunDetail();
          } catch (e) {
            // Non-fatal: we can still stream minimal events
            logger.debug("Could not fetch agent run details on start", e);
          }

          onEvent?.({
            type: "started",
            data: {
              run_id: runId,
              url: agentRunUrl,
              m: `Agent started: ${slug}`,
              agent_run: agentRunDetail,
              extra: extraFromStart,
            },
          });

          if (isStopped) return;

          const Pusher = await loadPusher();
          pusher = new Pusher(soketiKey,  {
            wsHost: soketiHost,
            wsPort: soketiPort,
            forceTLS: true,
            encrypted: true,
            disableStats: true,
            enabledTransports: ["ws", "wss"],
          });
          channel = pusher.subscribe(`agent-run-${runId}`);

          channel.bind("tool-call", (ev: any) => {
            void (async () => {
              if (isStopped) return;
              const toolName = ev?.tool_name ?? ev?.tool ?? "tool";

              let detail: any = undefined;
              try {
                detail = await fetchAgentRunDetail();
              } catch (e) {
                logger.debug("Could not fetch agent run details on tool-call", e);
              }

              if (isStopped) return;
              onEvent?.({
                type: "tool-call",
                data: {
                  run_id: runId,
                  tool_name: toolName,
                  iteration: ev?.iteration,
                  timestamp: ev?.timestamp,
                  url: agentRunUrl,
                  m: `Tool call: ${toolName}`,
                  agent_run: detail,
                  extra: extraFromStart,
                },
              });
            })();
          });

          channel.bind("agent-completed", (ev: any) => {
            void (async () => {
              if (isStopped) return;
              const status = ev?.status === "SUCCESS" ? "SUCCESS" : "ERROR";
              const finalMessage = ev?.final_message ?? ev?.finalMessage ?? null;

              let detail: any = undefined;
              try {
                detail = await fetchAgentRunDetail();
              } catch (e) {
                logger.debug("Could not fetch agent run details on completion", e);
              }

              if (isStopped) return;
              onEvent?.({
                type: "agent-completed",
                data: {
                  run_id: runId,
                  status,
                  final_message: finalMessage,
                  error_message: ev?.error_message,
                  iteration: ev?.iteration,
                  timestamp: ev?.timestamp,
                  url: agentRunUrl,
                  m: status === "SUCCESS" ? "Agent completed" : "Agent completed with error",
                  agent_run: detail,
                  extra: extraFromStart,
                },
              });

              onComplete?.(status === "SUCCESS", detail ?? ev);
              stop();
            })();
          });
        } catch (e: any) {
          const error = e?.message ? String(e.message) : "Unknown error running agent";
          logger.error("Error running agent", e);
          onEvent?.({ type: "error", data: { error, m: error } });
          onComplete?.(false, { error });
          stop();
        }
      })();
    };

    return { stop, run };
  },

  convertTool: function (func: any, name: string, description: string, parameters: any): TTool {
    return toolify(func, name, description, parameters);
  },

  complete: function ({
    templateSlug,
    payload = {},
    format = "html",
    stream = false,
    target,
    onComplete,
    onStart,
    onStream,
  }: TCompleteWithRigo) {
    logger.debug("Completing Rigobot");

    if (!templateSlug) {
      logger.error("No template slug provided");
      onComplete?.(false, { error: "No template slug provided" });
      return;
    }

    if (!target && !onComplete) {
      logger.error(
        "No target or onComplete provided, please set one of them to use the complete method"
      );
      return;
    }

    if (target && !(target instanceof HTMLElement)) {
      logger.error("Target is not an HTMLElement");
      onComplete?.(false, {
        error: "Target is not an HTMLElement",
      });
      return;
    }

    if (!payload) {
      logger.error("No payload provided");
      onComplete?.(false, { error: "No payload provided" });
      return;
    }

    if (!validFormats.includes(format)) {
      logger.error(
        `Invalid format ${format} provided, valid formats are: ${validFormats.join(
          ", "
        )}`
      );
      onComplete?.(false, { error: `Invalid format ${format} provided` });
      return;
    }

    if (!this.options?.user?.token) {
      logger.error(
        "No user token provided, currently, only user token can be used to use a template"
      );
      console.log("Current RigoAI options", this.options);

      return;
    }
    const websocketHost = this.options?.socketHost ?? "https://ai.4geeks.com";

    console.log("Connecting to socket", websocketHost);

    let temporalSocket = io(websocketHost, {
      autoConnect: true,
      transports: ["websocket", "polling"],
    });

    console.log("Temporal socket", temporalSocket);
    
    temporalSocket.connect();

    temporalSocket.on("connect", () => {
      console.log("Connected to socket");
    });

    const jobId = generateRandomId();
    let started = false;
    temporalSocket?.on(`completion-stream-${jobId}`, (data: any) => {
      if (!started) {
        onStart?.({
          when: new Date().toISOString(),
          url: window.location.href,
        });
        started = true;
      }

      if (target && format === "markdown") {
        target.innerHTML += data.chunk;
      } else if (target && format === "html") {
        target.innerHTML = convertToHTML(data.cumulative);
      } else {
        logger.error("Target is not an HTMLElement or format is not supported");
      }

      onStream?.({
        chunk: data.chunk,
        cumulative: data.cumulative,
      });
    });

    temporalSocket?.on(`completion-stream-end-${jobId}`, (data: any) => {
      onComplete?.(true, data);
      temporalSocket?.disconnect();
    });

    temporalSocket?.on(`error-${jobId}`, (data: any) => {
      onComplete?.(false, data);
    });

    const job: TAskJob = {
      stop: () => {
        temporalSocket?.off(`completion-stream-end-${jobId}`);
        temporalSocket?.off(`completion-stream-${jobId}`);
        temporalSocket?.disconnect();
      },

      run: async () => {
        temporalSocket.emit("hello", "world");
        if (!temporalSocket.connected) {
          console.log("Waiting for connection");
        }

        while (!temporalSocket.connected) {
          console.log("Waiting for connection");
          await wait(1000);
        }

        console.log("Connected to socket after waiting", temporalSocket.connected);
        
        temporalSocket?.emit("complete", {
          jobId,
          inputs: payload,
          templateSlug,
          includePurposeBrief: false,
          stream: stream,
          auth: {
            token: this.options?.user?.token,
          },
          purpose: {
            slug: this.options?.purposeSlug,
            id: this.options?.purposeId,
          },
        });
      },
    };

    return job;
  },

  use_template: function ({
    templateSlug,
    payload = {},
    format = "html",
    target,
    onComplete,
    onStart,
  }: TUseTemplateWithRigo) {
    logger.debug("Using template with Pusher");

    if (!templateSlug) {
      logger.error("No template slug provided");
      onComplete?.(false, { error: "No template slug provided" });
      return;
    }

    if (!target && !onComplete) {
      logger.error(
        "No target or onComplete provided, please set one of them to use the use_template method"
      );
      return;
    }

    if (target && !(target instanceof HTMLElement)) {
      logger.error("Target is not an HTMLElement");
      onComplete?.(false, {
        error: "Target is not an HTMLElement",
      });
      return;
    }

    if (!payload) {
      logger.error("No payload provided");
      onComplete?.(false, { error: "No payload provided" });
      return;
    }

    if (!validFormats.includes(format)) {
      logger.error(
        `Invalid format ${format} provided, valid formats are: ${validFormats.join(
          ", "
        )}`
      );
      onComplete?.(false, { error: `Invalid format ${format} provided` });
      return;
    }

    if (!this.options?.user?.token) {
      logger.error(
        "No user token provided, currently, only user token can be used to use a template"
      );
      console.log("Current RigoAI options", this.options);
      return;
    }

    const apiHost = import.meta.env.VITE_API_HOST;
    const soketiKey = import.meta.env.VITE_SOKETI_KEY;
    const soketiHost = import.meta.env.VITE_SOKETI_HOST;
    const soketiPort = import.meta.env.VITE_SOKETI_PORT;

    let pusherClient: any = null;
    let channel: any = null;
    let started = false;

    const job: TAskJob = {
      stop: () => {
        if (channel) {
          channel.unbind_all();
          channel.unsubscribe();
        }
        if (pusherClient) {
          pusherClient.disconnect();
        }
      },

      run: async () => {
        try {
          const response = await fetch(
            `${apiHost}/v1/prompting/use-template/${templateSlug}/`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Token ${this.options?.user?.token}`,
              },
              body: JSON.stringify({
                inputs: payload,
                include_purpose_objective: false,
              }),
            }
          );

          if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            onComplete?.(false, {
              error: errorData.detail || `HTTP error! status: ${response.status}`,
            });
            return;
          }

          const data = await response.json();
          const jobId = data.id;

          if (!jobId) {
            logger.error("No job ID returned from API");
            onComplete?.(false, { error: "No job ID returned from API" });
            return;
          }

          if (data.data) {
            onStart?.({
              when: new Date().toISOString(),
              url: window.location.href,
            });
            started = true;

            if (target && format === "markdown") {
              target.innerHTML = convertToHTML(data.data.answer || "");
            } else if (target && format === "html") {
              target.innerHTML = convertToHTML(data.data.answer || "");
            }

            onComplete?.(true, data.data);
            return;
          }

          const PusherLib = await loadPusher();

          pusherClient = new PusherLib(soketiKey,  {
            wsHost: soketiHost,
            wsPort: soketiPort,
            forceTLS: true,
            encrypted: true,
            disableStats: true,
            enabledTransports: ["ws", "wss"],
          });

          const channelName = `completion-job-${jobId}`;
          channel = pusherClient.subscribe(channelName);

          channel.bind("completion", (eventData: any) => {
            if (!started) {
              onStart?.({
                when: new Date().toISOString(),
                url: window.location.href,
              });
              started = true;
            }

            if (eventData.status === "SUCCESS" || eventData.status === "ERROR") {
              if (target && format === "markdown") {
                target.innerHTML = convertToHTML(eventData.answer || "");
              } else if (target && format === "html") {
                target.innerHTML = convertToHTML(eventData.answer || "");
              }

              const success = eventData.status === "SUCCESS";
              onComplete?.(success, eventData);

              channel.unbind_all();
              channel.unsubscribe();
              pusherClient.disconnect();
            }
          });

          pusherClient.connection.bind("error", (err: any) => {
            logger.error("Pusher connection error:", err);
            onComplete?.(false, { error: "Pusher connection error" });
          });

          pusherClient.connection.bind("disconnected", () => {
            logger.debug("Pusher disconnected");
          });
        } catch (error: any) {
          logger.error("Error in use_template:", error);
          onComplete?.(false, {
            error: error.message || "Unknown error occurred",
          });
          if (pusherClient) {
            pusherClient.disconnect();
          }
        }
      },
    };

    return job;
  },

  updateOptions: function (newOptions: Options) {
    if (newOptions.collapsed === undefined) {
      newOptions.collapsed = this.options?.collapsed;
    }

    this.options = { ...this.options, ...newOptions };
    logger.debug("Options updated to: ", this.options);

    const event = new CustomEvent("optionsUpdated", { detail: this.options });
    window.dispatchEvent(event);
  },
  version: packageJson.version,
};
