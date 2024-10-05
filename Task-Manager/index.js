const express = require('express');
require('dotenv').config();
const clc = require("cli-color");
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { userDataValidation, isEmailRgex } = require('./utils/authUtils');
const userModel = require('./models/userModel');
const session = require("express-session");
const mongodbSession = require('connect-mongodb-session')(session);
const isAuth = require('./middleware/authMiddleware');
const {todoValidation, generateToken, sendVerificationMail} = require('./utils/taskUtils');
const todoModel = require('./models/taskModel');
const ratelimiting = require("./middleware/rateLimiting");
const jwt = require('jsonwebtoken');


const app = express();
const PORT = process.env.PORT;
const store = new mongodbSession({
  uri: process.env.MONGO_URI,
  collection:'sessions'
})

mongoose
  .connect(process.env.MONGO_URI)
  .then(() => {
    console.log(clc.yellowBright.bold("mongodb connected successfully"));
  })
  .catch((err) => console.log(clc.redBright(err)));

  app.set('view engine', 'ejs');
  app.use(express.urlencoded({extended: true}));
  app.use(express.json());
  app.use(express.static('public'));
  app.use(session({
    secret : process.env.SECRET_KEY,
    store : store,
    resave: false,
    saveUninitialized: false,
  }))

app.get('/', (req, res) => {
  res.render('homePage');
});

app.get('/register', (req, res) => {
    return res.render('registerPage')
})
app.post('/register', async (req, res) => {
    console.log(req.body);
    const {name, email,  username, password} = req.body;

    try {
       await userDataValidation({email, username, name, password});
    } catch (error) {
        return res.status(400).json(error);
    }

    try {

      const userEmailExists = await userModel.findOne({email: email});
      if (userEmailExists) {
        return res.status(400).json({
          message: "Email already exists",
        });
      }

      const userUsernameExists = await userModel.findOne({username: username});
      if (userUsernameExists) {
        return res.status(400).json({
          message: "Username already exists",
        });
      }

    const hashedPassword = await bcrypt.hash(password, parseInt(process.env.SALT))

    const userObj = new userModel({
        name,
        email,
        username,
        password: hashedPassword,
    })

    
        const userDb = await userObj.save();

        const token = generateToken(email)
        console.log(token);

        sendVerificationMail(email, token)

        return res.redirect('/login');
      } catch (error) {
        return res.status(500).json({
          message: "Internal server error",
          error: error,
        });
      }
})

app.get("/verifytoken/:token", async (req, res) => {
  console.log(req.params.token);
  const token = req.params.token;
  const email = jwt.verify(token, process.env.SECRET_KEY);
  console.log(email);

  try {
    await userModel.findOneAndUpdate(
      { email: email },
      { isEmailVerified: true }
    );
    return res.send(`
      <html>
        <head>
          <script>
            setTimeout(function() {
              window.location.href = '/login'; // Redirect to login after 2 seconds
            }, 2000);
          </script>
        </head>
        <body>
          <h1>Email has been verified successfully!</h1>
          <p>You will be redirected to the login page shortly...</p>
        </body>
      </html>
    `);
  } catch (error) {
    return res.status(500).json(error);
  }
});

app.get('/login', (req, res) => {
    return res.render('loginPage')
})

app.post('/login', async(req, res) => {
  const { loginId, password } = req.body;
  if (!loginId || !password) {
    return res.status(400).json("Missing login credentials");
  }

  if (typeof loginId !== "string")
    return res.status(400).json("loginId is not a string");

  if (typeof password !== "string")
    return res.status(400).json("password is not a string");

  try {
    let userDb = {};
    if (isEmailRgex({ key: loginId })) {
      userDb = await userModel.findOne({ email: loginId });
    } else {
      userDb = await userModel.findOne({ username: loginId });
    }

    if (!userDb)
      return res.status(400).json("user not found, please register first");

    if(!userDb.isEmailVerified)
      return res.status(400).json("Please verify your email first");

    const isMatched = await bcrypt.compare(password, userDb.password);

    if (!isMatched) return res.status(400).json("Incorrect password");

    req.session.isAuth = true;
    req.session.user = {
      userId: userDb._id,
      email: userDb.email,
      username: userDb.username,
    }

    return res.redirect("/dashboard");
  } 
  
  catch (error) {
    return res.status(500).json(console.error());
  }



  
})

app.get('/dashboard', isAuth ,async(req, res) => { 
    return res.render('dashboardPage')
});

app.post('/logout', isAuth ,(req, res) => {
 req.session.destroy((err)=>{
  if(err) return res.status(500).json("Logout Unsuccessfull");
  return res.redirect('/login');
 })
});

app.post('/create-item', isAuth ,ratelimiting, async(req, res) => {
  const todo = req.body.todo;
  const username = req.session.user.username;

 try {
   await todoValidation({todo});
 } catch (error) {
  return res.status(400).json(error);
 }

 const userObj = new todoModel({
  todo: todo,
  username: username,
 })
 
 try {
  const todoDb = await userObj.save();

  return res.status(201).json({
    message: "Todo created successfully",
    data: todoDb,
  });
 } catch (error) {
  return res.status(500).json({
    message: "Internal Server Error",
    error: error,
  });
 }
 
})

app.get('/read-item', isAuth, async (req,res)=>{
 const username = req.session.user.username;
 const SKIP = Number(req.query.skip) || 0;
 const LIMIT = 5;
 
 try {
  // const todoDb = await todoModel.find({username : username});
  const todoDb = await todoModel.aggregate([
    {
    $match: {
      username: username
    }
  },
  {$skip : SKIP},
  {$limit : LIMIT}
  ])
  

  if(todoDb.length == 0){
    return res.send({
      status: 204,
      message: "No todo found",
    })
  }

  return res.send({
    status: 200,
    message: "Read item successfully",
    data: todoDb
  })
 } catch (error) {
  return res.send({
    status: 500,
    message: "Internal Server Error",
    error: error,
  })
 }
 
})

app.post("/edit-item", isAuth, async (req, res) => {
  const newData = req.body.newData;
  const todoId = req.body.todoId;
  const username = req.session.user.username;

  if (!todoId) return res.status(400).json("Todo id is missing");

  try {
    await todoValidation({ todo: newData });
  } catch (error) {
    return res.send({
      status: 400,
      message: error
    });
  }

  try {
    const todoDb = await todoModel.findOne({ _id: todoId });
    console.log(todoDb);

    if (!todoDb) {
      return res.send({
        status: 400,
        message: `todo not found with this id : ${todoId}`,
      });
    }

    //check the ownership
    console.log(username, todoDb.username);
    if (username !== todoDb.username) {
      return res.send({
        status: 403,
        message: "not allowed to edit the todo",
      });
    }

    //update the todo in db
    const todoDbPrev = await todoModel.findOneAndUpdate(
      { _id: todoId },
      { todo: newData }
    );

    return res.send({
      status: 200,
      message: "Todo updated sucecssfully",
      data: todoDbPrev,
    });
  } catch (error) {
    console.log(error);
    return res.send({
      status: 500,
      message: "Internal server error",
      errro: error,
    });
  }
});

app.post("/delete-item", isAuth, async (req, res) => {
  const todoId = req.body.todoId;
  const username = req.session.user.username;

  if (!todoId) return res.status(400).json("Todo id is missing");

  try {
    const todoDb = await todoModel.findOne({ _id: todoId });
    console.log(todoDb);

    if (!todoDb) {
      return res.send({
        status: 400,
        message: `todo not found with this id : ${todoId}`,
      });
    }

    //check the ownership
    console.log(username, todoDb.username);
    if (username !== todoDb.username) {
      return res.send({
        status: 403,
        message: "not allowed to delete the todo",
      });
    }

    //delete the todo in db
    await todoModel.deleteOne({ _id: todoId });

    return res.send({
      status: 200,
      message: "Todo deleted successfully",
    });
  } catch (error) {
    console.log(error);
    return res.send({
      status: 500,
      message: "Internal server error",
      error: error,
    });
  }
});


app.listen(PORT, () => {
    console.log(clc.yellowBright.bold(`server is running at:`));
    console.log(clc.yellowBright.underline(`http://localhost:${PORT}/`));
  });