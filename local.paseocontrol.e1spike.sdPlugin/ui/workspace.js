// Property Inspector of the Project dial (W6, projects since P2; the action
// UUID is still ".workspace"). Plain script, no library:
// it registers with Stream Deck as documented (connectElgatoStreamDeckSocket),
// renders the view the plugin sends as text only, and sends the user's
// choice back. All validation and storage happen in the plugin.
// The "Paseo connection" section (connection.js, C4b) shares this page's one
// socket: connection_* messages go to it, everything else stays Start in.
"use strict";

(function () {
  const select = document.getElementById("start-in");
  const status = document.getElementById("status");
  const notice = document.getElementById("notice");
  const message = document.getElementById("message");
  const retry = document.getElementById("projects-retry");
  // Without an answer the page leaves "Sending…" and shows the last view
  // the plugin confirmed, so a lost message is visible and can be retried.
  const ANSWER_TIMEOUT_MS = 5000;
  const NO_ANSWER =
    "No answer from the plugin; the setting is not confirmed. Choose again to retry.";
  const NOT_CONNECTED = "Not connected to Stream Deck; nothing was sent.";
  const NO_RETRY_ANSWER = "No answer from the plugin. Press Retry projects again.";

  let socket = null;
  let action = "";
  // Stream Deck 7.6.1 rejects sendToPlugin unless its context is this page's
  // own UUID ("from the wrong context" in its log); Elgato's sdpi-components
  // sends that UUID too. Views from the plugin carry the action's context.
  let inspectorUuid = "";
  let actionContext = "";
  let lastView = null;
  let waiting = null;

  function send(payload) {
    if (socket === null || socket.readyState !== 1) return false;
    socket.send(JSON.stringify({ action, context: inspectorUuid, event: "sendToPlugin", payload }));
    return true;
  }

  function stopWaiting() {
    if (waiting !== null) clearTimeout(waiting);
    waiting = null;
  }

  function showLastView(text) {
    if (lastView !== null) render({ ...lastView, message: text });
  }

  const isText = (value) => typeof value === "string";
  const isOptionalText = (value) => value === null || isText(value);

  function isOption(entry) {
    return (
      typeof entry === "object" &&
      entry !== null &&
      isText(entry.value) &&
      isText(entry.label) &&
      typeof entry.disabled === "boolean"
    );
  }

  // The whole view is checked before the page changes, so a malformed view
  // is ignored as a unit instead of leaving a half-updated page.
  function isView(view) {
    return (
      typeof view === "object" &&
      view !== null &&
      view.context === actionContext &&
      isText(view.status) &&
      isOptionalText(view.notice) &&
      isOptionalText(view.message) &&
      typeof view.canChoose === "boolean" &&
      typeof view.canRetry === "boolean" &&
      Array.isArray(view.options) &&
      view.options.length > 0 &&
      view.options.every(isOption) &&
      view.options.some((entry) => entry.value === view.selected)
    );
  }

  function render(view) {
    if (!isView(view)) return;
    stopWaiting();
    lastView = view;
    const options = view.options.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.value;
      option.textContent = entry.label;
      option.disabled = entry.disabled;
      return option;
    });
    select.replaceChildren(...options);
    select.value = view.selected;
    select.disabled = !view.canChoose;
    retry.hidden = !view.canRetry;
    retry.disabled = !view.canRetry;
    status.textContent = view.status;
    notice.textContent = view.notice ?? "";
    message.textContent = view.message ?? "";
  }

  select.addEventListener("change", () => {
    if (!send({ type: "choose", value: select.value })) {
      showLastView(NOT_CONNECTED);
      return;
    }
    select.disabled = true;
    message.textContent = "Sending…";
    stopWaiting();
    waiting = setTimeout(() => {
      waiting = null;
      showLastView(NO_ANSWER);
    }, ANSWER_TIMEOUT_MS);
  });

  // Retry reads the project list again; the plugin answers with a new view.
  retry.addEventListener("click", () => {
    if (!send({ type: "retry_projects" })) {
      showLastView(NOT_CONNECTED);
      return;
    }
    retry.disabled = true;
    message.textContent = "Sending…";
    stopWaiting();
    waiting = setTimeout(() => {
      waiting = null;
      showLastView(NO_RETRY_ANSWER);
    }, ANSWER_TIMEOUT_MS);
  });

  window.connectElgatoStreamDeckSocket = (port, uuid, registerEvent, _info, actionInfo) => {
    if (!/^\d+$/.test(String(port))) return;
    inspectorUuid = String(uuid);
    actionContext = inspectorUuid;
    try {
      const parsed = JSON.parse(actionInfo);
      action = typeof parsed.action === "string" ? parsed.action : "";
      if (typeof parsed.context === "string") actionContext = parsed.context;
    } catch {
      action = "";
    }
    const host = window.PaseoConnection;
    const connection =
      host !== null && typeof host === "object" && typeof host.attach === "function"
        ? host.attach({ context: actionContext, send: (payload) => send(payload) })
        : null;
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
    socket.onopen = () => {
      socket.send(JSON.stringify({ event: registerEvent, uuid }));
      send({ type: "refresh" });
      if (connection !== null) connection.start();
    };
    socket.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      // Settings changes need no handling here: the plugin sends a new view
      // for its own writes and for changes Stream Deck reports to it.
      if (data !== null && typeof data === "object" && data.event === "sendToPropertyInspector") {
        const payload = data.payload;
        const isConnection =
          payload !== null &&
          typeof payload === "object" &&
          typeof payload.type === "string" &&
          payload.type.startsWith("connection_");
        if (isConnection) {
          if (connection !== null) connection.receive(payload);
        } else {
          render(payload);
        }
      }
    };
    socket.onclose = () => {
      if (connection !== null) connection.closed();
      stopWaiting();
      select.disabled = true;
      retry.disabled = true;
      status.textContent = "Disconnected from Stream Deck.";
    };
  };
})();
