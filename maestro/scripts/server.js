// Talks to the fake field-sync server's control routes from a flow (Maestro's own JavaScript, not Node).
// ACTION: "reset" or "script"; BODY: the JSON of POST /__script; SERVER: where the fake listens.
var base = typeof SERVER !== "undefined" && SERVER ? SERVER : "http://127.0.0.1:8787";
var response = ACTION === "reset"
  ? http.post(base + "/__reset", { headers: { "Content-Type": "application/json" }, body: "{}" })
  : http.post(base + "/__script", { headers: { "Content-Type": "application/json" }, body: BODY });
if (response.status < 200 || response.status > 299) throw new Error("servidor falso respondeu " + response.status + ": " + response.body);
