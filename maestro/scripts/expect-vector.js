// Fails the flow unless the fake server's count of accepted bulletins (35a) is exactly what EXPECT says, e.g.
// EXPECT: '{ "inspections": 1, "samples": 1, "bodies_with_derived_reasons": 0 }'. Only the keys given are checked.
var base = typeof SERVER !== "undefined" && SERVER ? SERVER : "http://127.0.0.1:8787";
var vector = json(http.get(base + "/__state").body).vector;
var expected = json(EXPECT);
var keys = Object.keys(expected);
for (var i = 0; i < keys.length; i += 1) {
  if (vector[keys[i]] !== expected[keys[i]]) {
    throw new Error("boletins aceitos pelo servidor: " + JSON.stringify(vector) + "; esperado: " + JSON.stringify(expected));
  }
}
