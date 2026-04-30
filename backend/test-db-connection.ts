import pkg from "pg";
const { Client } = pkg;

async function showTables() {
  try {
    const databaseUrl = "postgresql://postgres:muhammadubaid182004@database-1.c70k80ia6kff.eu-north-1.rds.amazonaws.com:5432/postgres";

    const client = new Client({
      connectionString: databaseUrl,
      ssl: { rejectUnauthorized: false },
    });

    await client.connect();
    console.log("✅ Connected to PostgreSQL\n");

    // Query to list all tables
    const result = await client.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
      AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name;
    `);

    console.log("📋 Tables in database:\n");
    result.rows.forEach((row, index) => {
      console.log(`${index + 1}. ${row.table_schema}.${row.table_name}`);
    });

    await client.end();
    console.log("\n✅ Connection closed");
  } catch (error) {
    console.error("❌ Error:", error);
  }
}

showTables();