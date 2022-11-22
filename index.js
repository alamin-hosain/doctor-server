const express = require('express');
const cors = require('cors');
const port = process.env.PORT || 5000;
require('dotenv').config();
const app = express();
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const jwt = require('jsonwebtoken');
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

// middleware
app.use(cors());
app.use(express.json());


// Mongodb App uri and connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.gcdspqh.mongodb.net/?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });

function verifyJWT(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).send('UnAuthorized Access')
    }
    const token = authHeader.split(' ')[1];
    jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
        if (err) {
            return res.status(403).send({ message: 'Forbidden Access' })
        }
        req.decoded = decoded;
        next();
    })
}




async function run() {
    try {
        const appointmentCollectionOptions = client.db('doctorsDb').collection('appointmentOptions');
        const bookingCollection = client.db('doctorsDb').collection('bookings');
        const userCollection = client.db('doctorsDb').collection('users');
        const doctorCollection = client.db('doctorsDb').collection('doctors');
        const paymentsCollection = client.db('doctorsDb').collection('payments');

        const verifyAdmin = async (req, res, next) => {
            const decodedEmail = req.decoded.email;
            const query = { email: decodedEmail };
            const user = await userCollection.findOne(query);

            if (user?.role !== 'admin') {
                return res.status(403).send({ message: 'forbidden access' })
            }
            next();
        }

        //Getting all the appointment Options
        app.get('/appointments', async (req, res) => {
            const date = req.query.date;
            const query = {};
            const options = await appointmentCollectionOptions.find(query).toArray();
            const bookingQuery = { appointmentDate: date };
            const alreadyBooked = await bookingCollection.find(bookingQuery).toArray();

            options.forEach(option => {
                const optionBooked = alreadyBooked.filter(book => book.treatment === option.name);
                const bookedSlots = optionBooked.map(book => book.slot);
                const remainingSlots = option.slots.filter(slot => !bookedSlots.includes(slot));
                option.slots = remainingSlots;
            })
            res.send(options);

        })

        // Version 2 using Aggregator
        app.get('/v2/appointments', async (req, res) => {
            const date = req.query.date;
            const options = await appointmentCollectionOptions.aggregate([
                {
                    $lookup: {
                        from: 'bookings',
                        localField: 'name',
                        foreignField: 'treatment',
                        pipeline: [
                            {
                                $match: {
                                    $expr: {
                                        $eq: ['$appointmentDate', date]
                                    }
                                }
                            }
                        ],
                        as: 'booked'
                    }
                },

                {
                    $project: {
                        name: 1,
                        slots: 1,
                        price: 1,
                        booked: {
                            $map: {
                                input: '$booked',
                                as: 'book',
                                in: '$$book.slot'
                            }
                        }
                    }
                },
                {
                    $project: {
                        name: 1,
                        price: 1,
                        slots: {
                            $setDifference: ['$slots', '$booked']
                        }
                    }
                }

            ]).toArray();
            res.send(options)

        })

        app.get('/appointmentSpecialty', async (req, res) => {
            const query = {};
            const result = await appointmentCollectionOptions.find(query).project({ name: 1 }).toArray();
            res.send(result)
        })

        // Getting booking by Id
        app.get('/bookings/:id', async (req, res) => {
            const id = req.params.id;
            const query = { _id: ObjectId(id) };
            const booking = await bookingCollection.findOne(query);
            res.send(booking);
        })
        // Getting booking by user
        app.get('/bookings', verifyJWT, async (req, res) => {
            const email = req.query.email;
            const decodedEmail = req.decoded.email;
            if (email !== decodedEmail) {
                return res.status(403).send({ message: 'Forbidden Access' })
            }
            const query = { email: email };
            const bookings = await bookingCollection.find(query).toArray();
            res.send(bookings)
        })

        // Adding booking to database
        app.post('/bookings', async (req, res) => {
            const booking = req.body;
            const query = {
                appointmentDate: booking.appointmentDate,
                email: booking.email,
                treatment: booking.treatment,
            }
            const alreadyBooked = await bookingCollection.find(query).toArray();
            if (alreadyBooked.length) {
                const message = `You already have a booking on ${booking.appointmentDate}`;
                return res.send({ acknowledged: false, message })
            }

            const result = await bookingCollection.insertOne(booking);
            res.send(result);
        })

        //Stripe payment
        app.post('/create-payment-intent', async (req, res) => {
            const booking = req.body;
            const price = booking.price;
            const amount = price * 100;
            console.log(amount)
            const paymentIntent = await stripe.paymentIntents.create({
                currency: 'usd',
                amount: amount,
                "payment_method_types": [
                    "card"
                ],
            });

            res.send({
                clientSecret: paymentIntent.client_secret,
            });
        })

        // adding payment coolection
        app.post('/payments', async (req, res) => {
            const payment = req.body;
            const result = await paymentsCollection.insertOne(payment);
            const id = payment.bookingId;
            const filter = { _id: ObjectId(id) };
            const updatedDoc = {
                $set: {
                    paid: true,
                    transactionId: payment.transactionId,
                }
            }
            const updateResult = await bookingCollection.updateOne(filter, updatedDoc)
            res.send(result);
        })

        // adding json web token
        app.get('/jwt', async (req, res) => {
            const email = req.query.email;
            const query = { email: email };
            const user = await userCollection.find(query);
            if (user) {
                const token = jwt.sign({ email }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
                return res.send({ accessToken: token })
            }
            return res.status(403).send({ accessToken: '' })
        })

        // Getting All users
        app.get('/users', async (req, res) => {
            const query = {};
            const users = await userCollection.find(query).toArray();
            res.send(users)
        })

        // Getting Admin User
        app.get('/users/admin/:email', async (req, res) => {
            const email = req.params.email;
            const query = { email };
            const user = await userCollection.findOne(query);
            res.send({ isAdmin: user?.role === 'admin' })
        })

        // Adding user to database
        app.post('/users', async (req, res) => {
            const user = req.body;
            const result = await userCollection.insertOne(user);
            res.send(result)
        })

        // Updating user and adding admin Role
        app.put('/users/admin/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const option = { upsert: true }
            const updateDoc = {
                $set: {
                    role: 'admin'
                }
            }
            const result = await userCollection.updateOne(filter, updateDoc, option);
            res.send(result);
        })

        //temporary to update price field on appointment options
        // app.get('/addprice', async (req, res) => {
        //     const filter = {};
        //     const options = { upsert: true };
        //     const updateDoc = {
        //         $set: {
        //             price: 99,
        //         }
        //     }
        //     const result = await appointmentCollectionOptions.updateMany(filter, updateDoc, options);
        //     res.send(result)
        // })

        //getting all the doctors
        app.get('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const query = {};
            const doctors = await doctorCollection.find(query).toArray();
            res.send(doctors)
        })

        // Adding doctors to database
        app.post('/doctors', verifyJWT, verifyAdmin, async (req, res) => {
            const doctor = req.body;
            console.log(doctor);
            const result = await doctorCollection.insertOne(doctor);
            res.send(result);
        })

        // Deleting doctor by id
        app.delete('/doctors/:id', verifyJWT, verifyAdmin, async (req, res) => {
            const id = req.params.id;
            const filter = { _id: ObjectId(id) };
            const result = await doctorCollection.deleteOne(filter);
            res.send(result)
        })

    }

    finally {

    }
}
run().catch(e => console.log(e))






















// Server start and Checking on Port
app.get('/', async (req, res) => { res.send('doctors portal started') })
app.listen(port, () => console.log('Server running on port', port))