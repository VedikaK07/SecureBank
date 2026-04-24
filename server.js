require('dotenv').config();

const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

pool.query('SELECT NOW()')
  .then(() => console.log('Supabase connected'))
  .catch(err => console.log('Supabase error:', err.message));

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT NOW()');

    res.json({
      status: 'online'
    });
  } catch (err) {
    res.status(500).json({
      status: 'offline',
      error: err.message
    });
  }
});

app.get('/api/accounts', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM accounts ORDER BY account_id'
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.get('/api/transactions', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM transactions ORDER BY created_at DESC'
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.get('/api/fraud-alerts', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM fraud_alerts ORDER BY created_at DESC'
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.get('/api/loans', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM loan_applications ORDER BY created_at DESC'
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.get('/api/audit', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM audit_logs ORDER BY created_at DESC'
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.get('/api/node-status', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT node, COUNT(*) AS total_accounts
      FROM accounts
      GROUP BY node
      ORDER BY node
    `);

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: err.message
    });
  }
});

app.get('/api/explain', async (req, res) => {
  const { query } = req.query;

  try {
    const result = await pool.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`
    );

    res.json(result.rows[0]['QUERY PLAN']);
  } catch (err) {
    res.status(400).json({
      error: err.message
    });
  }
});

app.post('/api/transfer', async (req, res) => {
  const { from_account, to_account, amount, txn_type } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const fromResult = await client.query(
      'SELECT account_id, balance, node FROM accounts WHERE account_id = $1',
      [from_account]
    );

    const toResult = await client.query(
      'SELECT account_id, balance, node FROM accounts WHERE account_id = $1',
      [to_account]
    );

    if (fromResult.rows.length === 0) {
      throw new Error('From account not found');
    }

    if (toResult.rows.length === 0) {
      throw new Error('To account not found');
    }

    const fromData = fromResult.rows[0];
    const toData = toResult.rows[0];

    if (parseFloat(fromData.balance) < parseFloat(amount)) {
      throw new Error('Insufficient balance');
    }

    const fromNode = fromData.node;
    const toNode = toData.node;
    const crossNode = fromNode !== toNode;

    await client.query(
      'UPDATE accounts SET balance = balance - $1 WHERE account_id = $2',
      [amount, from_account]
    );

    await client.query(
      'UPDATE accounts SET balance = balance + $1 WHERE account_id = $2',
      [amount, to_account]
    );

    const transactionResult = await client.query(
      `INSERT INTO transactions
      (from_account, to_account, amount, txn_type, status, node)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING txn_id`,
      [
        from_account,
        to_account,
        amount,
        txn_type || 'TRANSFER',
        'completed',
        fromNode
      ]
    );

    if (parseFloat(amount) > 75000) {
      await client.query(
        `INSERT INTO fraud_alerts
        (txn_id, account_id, rule_triggered, risk_level)
        VALUES ($1, $2, $3, $4)`,
        [
          transactionResult.rows[0].txn_id,
          from_account,
          'High Value Transfer',
          'HIGH'
        ]
      );
    }

    await client.query(
      `INSERT INTO audit_logs
      (user_name, role, action, table_name)
      VALUES ($1, $2, $3, $4)`,
      [
        'system',
        'banking_service',
        `Transferred ${amount} from ${from_account} to ${to_account}`,
        'transactions'
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      cross_node: crossNode,
      from_node: fromNode,
      to_node: toNode,
      message: 'Transfer completed successfully'
    });
  } catch (err) {
    await client.query('ROLLBACK');

    res.status(500).json({
      success: false,
      error: err.message
    });
  } finally {
    client.release();
  }
});

app.get('/api/test-transfer', async (req, res) => {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    await client.query(
      'UPDATE accounts SET balance = balance - 5000 WHERE account_id = $1',
      ['ACC001']
    );

    await client.query(
      'UPDATE accounts SET balance = balance + 5000 WHERE account_id = $1',
      ['ACC040']
    );

    await client.query(
      `INSERT INTO transactions
      (from_account, to_account, amount, txn_type, status, node)
      VALUES ($1, $2, $3, $4, $5, $6)`,
      ['ACC001', 'ACC040', 5000, 'TRANSFER', 'completed', 'A']
    );

    await client.query(
      `INSERT INTO audit_logs
      (user_name, role, action, table_name)
      VALUES ($1, $2, $3, $4)`,
      [
        'system',
        'banking_service',
        'Test transfer from ACC001 to ACC040',
        'transactions'
      ]
    );

    await client.query('COMMIT');

    res.json({
      success: true,
      message: 'Test transfer completed successfully'
    });
  } catch (err) {
    await client.query('ROLLBACK');

    res.status(500).json({
      success: false,
      error: err.message
    });
  } finally {
    client.release();
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`SecureBank API running on port ${process.env.PORT || 3000}`);
});