"use strict";
/*
 * The MONI Bot chat.
 *
 * Talks to /console/:id/send, which answers with newline-delimited JSON straight
 * from the Claude CLI and holds the connection open for the length of the turn.
 * Rendering as it arrives is the point: a turn can run for minutes, and a
 * spinner tells you nothing about whether it is doing the right thing. Watching
 * which files it reads is most of how you tell whether it understood you.
 *
 * Loaded on every page and returns immediately when there is no chat on screen.
 */
(function () {
  var compose = document.getElementById("chat-compose");
  if (!compose) return;

  var scroll = document.getElementById("chat-scroll");
  var input = document.getElementById("chat-input");
  var sendBtn = document.getElementById("chat-send");
  var stopBtn = document.getElementById("chat-stop");
  var status = document.getElementById("chat-status");
  var sessionId = compose.getAttribute("data-session");
  var csrf = compose.getAttribute("data-csrf");
  var running = false;

  function atBottom() {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80;
  }

  /* Follow the output only if the reader is already at the bottom. Yanking the
     view back while somebody is reading earlier output is maddening. */
  function toBottom(force) {
    if (force || atBottom()) scroll.scrollTop = scroll.scrollHeight;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function addMessage(role, text) {
    var wrap = el("div", "msg " + role);
    wrap.appendChild(el("div", role === "system" ? "note" : "bubble", text || ""));
    scroll.appendChild(wrap);
    toBottom(true);
    return wrap.firstChild;
  }

  function addTool(name, summary) {
    var row = el("div", "tool-row");
    row.appendChild(el("span", "tool-name", name));
    if (summary) row.appendChild(el("span", "tool-arg", summary));
    scroll.appendChild(row);
    toBottom();
  }

  /* One line describing what a tool was asked to do. Whichever field is most
     telling, in the order that usually matters. */
  function summarise(args) {
    if (!args) return "";
    if (args.command) return String(args.command).slice(0, 160);
    if (args.file_path) return String(args.file_path);
    if (args.path) return String(args.path);
    if (args.pattern) return String(args.pattern).slice(0, 80);
    if (args.url) return String(args.url);
    if (args.prompt) return String(args.prompt).slice(0, 120);
    try {
      return JSON.stringify(args).slice(0, 120);
    } catch (e) {
      return "";
    }
  }

  function setRunning(state) {
    running = state;
    sendBtn.disabled = state;
    stopBtn.hidden = !state;
    input.disabled = state;
    if (!state) status.textContent = "";
  }

  function handleEvent(ev, ctx) {
    if (ev.type === "stream_event" && ev.event) {
      var d = ev.event.delta;
      if (ev.event.type === "content_block_delta" && d && d.type === "text_delta" && d.text) {
        if (!ctx.bubble) ctx.bubble = addMessage("assistant", "");
        ctx.bubble.textContent += d.text;
        toBottom();
      }
      if (
        ev.event.type === "content_block_start" &&
        ev.event.content_block &&
        ev.event.content_block.type === "thinking"
      ) {
        status.textContent = "thinking…";
      }
      return;
    }

    if (ev.type === "assistant" && ev.message && ev.message.content) {
      ev.message.content.forEach(function (block) {
        if (block.type === "tool_use") {
          status.textContent = block.name + "…";
          addTool(block.name, summarise(block.input));
          // A tool call closes the current prose block, so the next text opens
          // a new bubble beneath it and the order on screen matches reality.
          ctx.bubble = null;
        } else if (block.type === "text" && block.text && !ctx.bubble) {
          // Only when the partial deltas did not already render it.
          ctx.bubble = addMessage("assistant", block.text);
        }
      });
      return;
    }

    if (ev.type === "result") {
      if (!ctx.bubble && ev.result) ctx.bubble = addMessage("assistant", ev.result);
      var bits = [];
      if (ev.duration_ms) bits.push(Math.round(ev.duration_ms / 100) / 10 + "s");
      if (ev.total_cost_usd) bits.push("$" + Number(ev.total_cost_usd).toFixed(4));
      if (ev.num_turns) bits.push(ev.num_turns + " turns");
      if (bits.length) scroll.appendChild(el("div", "msg-meta", bits.join(" · ")));
      if (ev.is_error) addMessage("system", "That turn reported an error.");
      toBottom();
      return;
    }

    if (ev.type === "moni_error") {
      addMessage("system", "Could not run that turn: " + ev.error);
      return;
    }

    if (ev.type === "moni_done" && ev.exit_code !== 0) {
      addMessage(
        "system",
        ev.stderr ? "Ended with an error:\n" + ev.stderr : "The turn ended unexpectedly."
      );
    }
  }

  function post(path, extra) {
    var body = new URLSearchParams();
    body.set("_csrf", csrf);
    Object.keys(extra || {}).forEach(function (k) {
      body.set(k, extra[k]);
    });
    return fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  function send(text) {
    if (running || !text.trim()) return;
    addMessage("user", text);
    input.value = "";
    setRunning(true);
    status.textContent = "working…";

    var ctx = { bubble: null };

    post("/console/" + sessionId + "/send", { prompt: text })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(
            function (d) {
              throw new Error(d.error || "Request refused.");
            },
            function () {
              throw new Error("Request refused.");
            }
          );
        }
        var reader = res.body.getReader();
        var decoder = new TextDecoder();
        var buffer = "";

        function pump() {
          return reader.read().then(function (chunk) {
            if (chunk.done) {
              if (buffer.trim()) {
                try {
                  handleEvent(JSON.parse(buffer), ctx);
                } catch (e) {
                  /* a trailing partial line is not ours to interpret */
                }
              }
              return;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            var lines = buffer.split("\n");
            buffer = lines.pop();
            lines.forEach(function (line) {
              if (!line.trim()) return;
              try {
                handleEvent(JSON.parse(line), ctx);
              } catch (e) {
                /* not an event we emitted */
              }
            });
            return pump();
          });
        }
        return pump();
      })
      .catch(function (e) {
        addMessage("system", e.message || "The connection dropped.");
      })
      .then(function () {
        setRunning(false);
        toBottom(true);
      });
  }

  compose.addEventListener("submit", function (ev) {
    ev.preventDefault();
    send(input.value);
  });

  /* Enter sends, Shift+Enter breaks the line -- the convention every chat uses,
     and the reason this is a textarea rather than an input. */
  input.addEventListener("keydown", function (ev) {
    if (ev.key === "Enter" && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      ev.preventDefault();
      send(input.value);
    }
  });

  stopBtn.addEventListener("click", function () {
    status.textContent = "stopping…";
    post("/console/" + sessionId + "/stop", {}).catch(function () {
      /* the stream ending is the real signal that it stopped */
    });
  });

  Array.prototype.forEach.call(document.querySelectorAll("[data-suggest]"), function (btn) {
    btn.addEventListener("click", function () {
      input.value = btn.getAttribute("data-suggest");
      input.focus();
    });
  });

  toBottom(true);
  input.focus();
})();

/* Selects that apply on change, so the chat header needs no Apply button. */
(function () {
  Array.prototype.forEach.call(
    document.querySelectorAll("select[data-autosubmit]"),
    function (sel) {
      sel.addEventListener("change", function () {
        if (sel.form) sel.form.submit();
      });
    }
  );

  Array.prototype.forEach.call(
    document.querySelectorAll("[data-set-access]"),
    function (link) {
      link.addEventListener("click", function (ev) {
        ev.preventDefault();
        var form = document.querySelector(".chat-controls");
        if (!form) return;
        var sel = form.querySelector('select[name="access"]');
        if (!sel || sel.disabled) return;
        sel.value = link.getAttribute("data-set-access");
        form.submit();
      });
    }
  );
})();
