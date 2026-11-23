// Fails the flow unless the fake server's count of accepted bulletins (35a) is exactly what EXPECT says, e.g.
// EXPECT: '{ "inspections": 1, "samples": 1, "bodies_with_derived_reasons": 0, "activities": ["li"] }'. Only the keys given
// are checked; `activities` is the bulletins' activity, in the order the server accepted them.
var base = typeof SERVER !== "undefined" && SERVER ? SERVER : "http://127.0.0.1:8787";
var vector = json(http.get(base + "/__state").body).vector;
var expected = json(EXPECT);
var keys = Object.keys(expected);
for (var i = 0; i < keys.length; i += 1) {
  if (JSON.stringify(vector[keys[i]]) !== JSON.stringify(expected[keys[i]])) {
    throw new Error("boletins aceitos pelo servidor: " + JSON.stringify(vector) + "; esperado: " + JSON.stringify(expected));
  }
}
