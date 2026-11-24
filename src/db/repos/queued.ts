// What the line still points to among the vector rows, shared by the territory wipe and the household's removal.
//
// An ovitrap installed on the tablet the queue still needs: its installation is in the line, or a collection in the
// line names it by its client_uuid (the installation accepted, the collection not yet). The server's ovitraps come back
// with the next download, and a collection that names one by ovitrap_id never reads the local row.
export const QUEUED_OVITRAP = `client_uuid IS NOT NULL AND (
  client_uuid IN (SELECT client_uuid FROM outbox)
  OR client_uuid IN (SELECT json_extract(body, '$.ovitrap_client_uuid') FROM outbox
                     WHERE type = 'ovitrap_collection' AND json_extract(body, '$.ovitrap_client_uuid') IS NOT NULL))`;

// The same rule for an animal born on the tablet: its creation is in the line, or any item in the line (a vaccination, a
// collar, a collection) names it by animal_client_uuid while the creation is not yet accepted. The server's animals come
// back with the next download, and an item that names one by animal_id never reads the local row.
export const QUEUED_ANIMAL = `client_uuid IS NOT NULL AND (
  client_uuid IN (SELECT client_uuid FROM outbox)
  OR client_uuid IN (SELECT json_extract(body, '$.animal_client_uuid') FROM outbox
                     WHERE json_extract(body, '$.animal_client_uuid') IS NOT NULL))`;
