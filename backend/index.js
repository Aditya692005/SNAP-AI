const express = require('express')
const supabase = require('./supabase/supabase')
require('dotenv').config()

const app = express()
app.use(express.json())

// example route - fetch all users
app.get('/users', async (req, res) => {
  const { data, error } = await supabase.from('users').select('*')
  if (error) return res.status(500).json({ error })
  res.json(data)
})

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`)
})