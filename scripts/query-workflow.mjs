import { Client } from 'pg';

async function main() {
  const client = new Client({
    connectionString: "postgresql://nango:nango@localhost:5433/nango"
  });
  
  try {
    await client.connect();
    
    // Get the latest workflow
    const res = await client.query(`
      SELECT id, name, spec, created_at 
      FROM workflow 
      ORDER BY created_at DESC 
      LIMIT 1;
    `);
    
    if (res.rows.length > 0) {
      console.log(JSON.stringify(res.rows[0], null, 2));
    } else {
      console.log("No workflows found.");
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    await client.end();
  }
}

main();
