// Fails the flow unless the fake server's count of accepted zoonoses items (35b) is what EXPECT says, e.g.
// EXPECT: '{ "animals": 1, "animals_with_tutor": 1 }'. Only the keys given are checked; the keys are the `zoonoses` of
// GET /__state: animals, animals_with_tutor, vaccinations, collections, collars.
var base = typeof SERVER !== "undefined" && SERVER ? SERVER : "http://127.0.0.1:8787";
var zoonoses = json(http.get(base + "/__state").body).zoonoses;
var expected = json(EXPECT);
var keys = Object.keys(expected);
for (var i = 0; i < keys.length; i += 1) {
  if (JSON.stringify(zoonoses[keys[i]]) !== JSON.stringify(expected[keys[i]])) {
    throw new Error("itens de zoonoses aceitos pelo servidor: " + JSON.stringify(zoonoses) + "; esperado: " + JSON.stringify(expected));
  }
}
