// Probe: a function with a real SQL-injection bug, to verify the review path
// reports it with a populated body (the markdown renderer fix) and that the
// worker's safety gate can read it.
export async function findUsers(db: { query: (sql: string) => Promise<unknown> }, ids: string[]) {
	const sql = `SELECT * FROM users WHERE id IN (${ids.join(",")})`
	return db.query(sql)
}
