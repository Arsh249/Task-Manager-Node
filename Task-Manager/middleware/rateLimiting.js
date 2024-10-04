const accessModel = require("../models/accessModel");

const ratelimiting = async (req, res, next) => {
  console.log(req.session.id);
  const sid = req.session.id;
  try {
    const accessDb = await accessModel.findOne({ sessionId: sid });
    
    if (!accessDb) {
      const accessObj = new accessModel({ sessionId: sid, time: Date.now() });
      await accessObj.save();
      next();
      return;
    }

    const diff = (Date.now() - accessDb.time) / 1000;

    if (diff < 5) {
      return res
        .status(400)
        .json("Too many request, please wait for some time");
    }

    const db = await accessModel.findOneAndUpdate(
      { sessionId: sid },
      { time: Date.now() }
    );
    next();
  } catch (error) {
    console.log(error);
    return res.status(500).json(error);
  }
};

module.exports = ratelimiting;
