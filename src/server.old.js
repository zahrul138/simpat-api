const express = require("express");
const app = express();
const cors = require("cors");

app.use(cors());
app.use(express.json()); 

app.use("/users", require("./routes/users"));

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on ${PORT}`));

const customersRoutes = require('./routes/customers');
app.use('/api/customers', customersRoutes);

