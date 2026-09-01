const originalFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin === "https://docs.varity.so" && url.pathname === "/llms-full.txt") {
    return Promise.resolve(new Response(
      "# Deploy applications\nDeploy an application using Varity's public documentation.",
      { status: 200, headers: { "Content-Type": "text/plain" } },
    ));
  }
  return originalFetch(input, init);
};
