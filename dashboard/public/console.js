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

  /* Tool calls are folded into one line per turn -- "Ran 8 commands", click to
     expand. The full list is noise while you are reading an answer, but it is
     the only record of what actually happened, so it is hidden rather than
     discarded. */
  function addTool(ctx, name, summary) {
    if (!ctx.activity) {
      var box = el("details", "activity");
      var head = el("summary", null, "");
      box.appendChild(head);
      var body = el("div", "activity-body");
      box.appendChild(body);
      scroll.appendChild(box);
      ctx.activity = { box: box, head: head, body: body, count: 0 };
    }
    var a = ctx.activity;
    a.count += 1;
    a.head.textContent = a.count === 1 ? "1 step" : a.count + " steps";

    var row = el("div", "tool-row");
    row.appendChild(el("span", "tool-name", name));
    if (summary) row.appendChild(el("span", "tool-arg", summary));
    a.body.appendChild(row);
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
          addTool(ctx, block.name, summarise(block.input));
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

    /* Ask-first mode: the turn is paused until this is answered, so the
       question is a card in the transcript rather than a dialog somewhere
       else. It disappears the moment it is answered. */
    if (ev.type === "moni_permission") {
      var card = el("div", "permission");
      card.appendChild(el("div", "perm-title", ev.title || "May it run this?"));
      var what = el("div", "perm-what");
      what.appendChild(el("span", "tool-name", ev.tool));
      what.appendChild(el("span", "tool-arg", summarise(ev.input)));
      card.appendChild(what);
      if (ev.description) card.appendChild(el("div", "perm-desc", ev.description));

      var row = el("div", "perm-actions");
      var allow = el("button", "btn primary small", "Allow");
      var deny = el("button", "btn small", "Skip");
      allow.type = "button";
      deny.type = "button";

      function answer(decision) {
        allow.disabled = true;
        deny.disabled = true;
        card.className = "permission answered";
        row.textContent = decision === "allow" ? "Allowed" : "Skipped";
        status.textContent = "working…";
        post("/console/" + sessionId + "/permission", {
          request_id: String(ev.request_id),
          decision: decision,
        }).catch(function () {
          addMessage("system", "Could not send that answer.");
        });
      }

      allow.addEventListener("click", function () { answer("allow"); });
      deny.addEventListener("click", function () { answer("deny"); });
      row.appendChild(allow);
      row.appendChild(deny);
      card.appendChild(row);
      scroll.appendChild(card);
      status.textContent = "waiting for you…";
      toBottom(true);
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
    var ready = attached.filter(function (a) { return !a.pending && a.path; });
    if (running || (!text.trim() && !ready.length)) return;
    if (attached.some(function (a) { return a.pending; })) {
      status.textContent = "still uploading…";
      return;
    }

    // Attachments reach the model as paths it can open with its own tools,
    // listed above the message so it knows they belong to what was just said.
    var body = text;
    if (ready.length) {
      body =
        "Attached files:\n" +
        ready.map(function (a) { return "- " + a.path; }).join("\n") +
        (text.trim() ? "\n\n" + text : "");
    }

    addMessage("user", body);
    input.value = "";
    input.style.height = "";
    attached = [];
    drawAttachments();
    setRunning(true);
    status.textContent = "working…";

    var ctx = { bubble: null, activity: null };

    post("/console/" + sessionId + "/send", { prompt: body })
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

  /* ------------------------------------------------------- attachments -- */

  var attachBox = document.getElementById("chat-attachments");
  var fileInput = document.getElementById("chat-file");
  var attachBtn = document.getElementById("chat-attach");
  var micBtn = document.getElementById("chat-mic");
  var attached = [];

  function drawAttachments() {
    attachBox.textContent = "";
    attachBox.hidden = attached.length === 0;
    attached.forEach(function (item, i) {
      var chip = el("span", "attachment" + (item.pending ? " pending" : ""));
      chip.appendChild(el("span", "attachment-name", item.name));
      if (!item.pending) {
        var x = el("button", "attachment-x", "×");
        x.type = "button";
        x.title = "Remove";
        x.addEventListener("click", function () {
          attached.splice(i, 1);
          drawAttachments();
        });
        chip.appendChild(x);
      }
      attachBox.appendChild(chip);
    });
  }

  /* Uploaded rather than inlined: the console reads files from disk with its
     own tools, exactly as it would a file that was already there, so a path is
     more useful to it than a blob would be. */
  function upload(file) {
    var item = { name: file.name || "file", pending: true };
    attached.push(item);
    drawAttachments();

    var reader = new FileReader();
    reader.onload = function () {
      var b64 = String(reader.result).split(",")[1] || "";
      post("/console/" + sessionId + "/upload", { name: item.name, data: b64 })
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.error) throw new Error(d.error);
          item.pending = false;
          item.path = d.path;
          drawAttachments();
        })
        .catch(function (e) {
          attached.splice(attached.indexOf(item), 1);
          drawAttachments();
          addMessage("system", "Could not attach " + item.name + ": " + e.message);
        });
    };
    reader.readAsDataURL(file);
  }

  attachBtn.addEventListener("click", function () { fileInput.click(); });
  fileInput.addEventListener("change", function () {
    Array.prototype.forEach.call(fileInput.files, upload);
    fileInput.value = "";
  });

  input.addEventListener("paste", function (ev) {
    var items = (ev.clipboardData && ev.clipboardData.files) || [];
    if (!items.length) return;
    ev.preventDefault();
    Array.prototype.forEach.call(items, upload);
  });

  ["dragover", "drop"].forEach(function (name) {
    compose.addEventListener(name, function (ev) {
      ev.preventDefault();
      compose.classList.toggle("dropping", name === "dragover");
      if (name === "drop" && ev.dataTransfer && ev.dataTransfer.files) {
        Array.prototype.forEach.call(ev.dataTransfer.files, upload);
      }
    });
  });
  compose.addEventListener("dragleave", function () {
    compose.classList.remove("dropping");
  });

  /* -------------------------------------------------------------- voice -- */

  var recorder = null;
  var chunks = [];

  function stopRecording() {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  }

  micBtn.addEventListener("click", function () {
    if (recorder && recorder.state === "recording") return stopRecording();
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      return addMessage("system", "This browser cannot record audio.");
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (stream) {
        chunks = [];
        recorder = new MediaRecorder(stream);
        recorder.ondataavailable = function (e) {
          if (e.data.size) chunks.push(e.data);
        };
        recorder.onstop = function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          micBtn.classList.remove("recording");
          status.textContent = "transcribing…";

          var blob = new Blob(chunks, { type: "audio/webm" });
          var reader = new FileReader();
          reader.onload = function () {
            post("/console/" + sessionId + "/transcribe", {
              data: String(reader.result).split(",")[1] || "",
            })
              .then(function (r) { return r.json(); })
              .then(function (d) {
                status.textContent = "";
                if (d.error) throw new Error(d.error);
                // Dropped into the box rather than sent, so a mis-heard word
                // can be fixed before it goes anywhere.
                input.value = input.value ? input.value + " " + d.text : d.text;
                resize();
                input.focus();
              })
              .catch(function (e) {
                status.textContent = "";
                addMessage("system", "Could not transcribe that: " + e.message);
              });
          };
          reader.readAsDataURL(blob);
        };
        recorder.start();
        micBtn.classList.add("recording");
        status.textContent = "recording — tap the mic to stop";
      })
      .catch(function () {
        addMessage("system", "Microphone access was refused.");
      });
  });

  sendBtn.addEventListener("click", function () {
    send(input.value);
  });

  /* The textarea grows with the message, up to a point, so a long paste is
     readable without pushing the transcript off screen. */
  function resize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
  }
  input.addEventListener("input", resize);

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
