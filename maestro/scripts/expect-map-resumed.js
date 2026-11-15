// Fails the flow unless the fake server cut one map download and the tablet resumed it with a Range
// (one 206), instead of downloading the whole file again.
var base = typeof SERVER !== "undefined" && SERVER ? SERVER : "http://127.0.0.1:8787";
var map = json(http.get(base + "/__state").body).map;
if (map.cut !== 1 || map.partial !== 1 || map.whole !== 0) {
  throw new Error("esperado 1 corte, 1 retomada e nenhum download inteiro; veio " + JSON.stringify(map));
}
