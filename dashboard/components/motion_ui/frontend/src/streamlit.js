// Minimal implementation of the Streamlit custom-component (v1) iframe protocol, so the
// bundle has no dependency on streamlit-component-lib and its React version pins.

function post(type, data = {}) {
  window.parent.postMessage({ isStreamlitMessage: true, type, ...data }, "*");
}

export const Streamlit = {
  ready() {
    post("streamlit:componentReady", { apiVersion: 1 });
  },
  setFrameHeight(height) {
    post("streamlit:setFrameHeight", { height: Math.ceil(height) });
  },
  setComponentValue(value) {
    post("streamlit:setComponentValue", { value, dataType: "json" });
  },
  onRender(callback) {
    const handler = (event) => {
      if (event.data && event.data.type === "streamlit:render") callback(event.data.args || {});
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  },
};
