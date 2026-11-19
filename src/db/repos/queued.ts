// What the line still points to among the vector rows, shared by the territory wipe and the household's removal.
//
// An ovitrap installed on the tablet the queue still needs: its installation is in the line, or a collection in the
// line names it by its client_uuid (the installation accepted, the collection not yet). The server's ovitraps come back
// with the next download, and a collection that names one by ovitrap_id never reads the local row.
export const QUEUED_OVITRAP = `client_uuid IS NOT NULL AND (
  client_uuid IN (SELECT client_uuid FROM outbox)
  OR client_uuid IN (SELECT json_extract(body, '$.ovitrap_client_uuid') FROM outbox
                     WHERE type = 'ovitrap_collection' AND json_extract(body, '$.ovitrap_client_uuid') IS NOT NULL))`;
