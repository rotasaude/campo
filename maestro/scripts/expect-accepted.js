// Fails the flow unless the fake server accepted exactly the items EXPECT says, e.g.
// EXPECT: '{ "household": 1, "family": 1 }'.
var base = typeof SERVER !== "undefined" && SERVER ? SERVER : "http://127.0.0.1:8787";
var accepted = json(http.get(base + "/__state").body).accepted;
var expected = json(EXPECT);
var types = Object.keys(expected).concat(Object.keys(accepted));
for (var i = 0; i < types.length; i += 1) {
  if ((accepted[types[i]] || 0) !== (expected[types[i]] || 0)) {
    throw new Error("aceitos pelo servidor: " + JSON.stringify(accepted) + "; esperado: " + JSON.stringify(expected));
  }
}
