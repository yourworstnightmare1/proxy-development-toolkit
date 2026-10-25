import LibcurlClient from "/libcurl/index.mjs";

// The bundled wasm finishes loading asynchronously after import, and
// LibcurlClient.init() throws until it has, so the first session after a page
// (or bare-mux worker) load would otherwise fail.
export default class ReadyLibcurlClient extends LibcurlClient {
  async init() {
    const deadline = Date.now() + 15000;
    for (;;) {
      try {
        return await super.init();
      } catch (error) {
        if (!/wasm not loaded/i.test(String(error?.message || error)) || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
}
