const moment 	= require("moment")
const Stripe 	= require("stripe")
const express 	= require("express")
const router 	= express.Router()
const ejs 		= require("ejs")
//const mailgun 	= require("mailgun.js")

let options = {}

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

const billing = async (customerId, user) => {

	let stripe = Stripe(options.secretKey)

	if (!customerId) {
		return {
			sources: [],
			invoices: [],
			subscriptions: [],
			user: user,
			options: options
		}
	}

	let stripeCustomer = await stripe.customers.retrieve(customerId)

	let sources = stripeCustomer.sources.data
	let subscriptions = stripeCustomer.subscriptions.data

	let defaultCard = sources.find(s => s.id = stripeCustomer.default_source)
	if (defaultCard) defaultCard.isDefault = true

	subscriptions = subscriptions.map(sub => {

		sub.currentPeriodStart = moment(sub.current_period_start * 1000).format("ll")
		sub.currentPeriodEnd = moment(sub.current_period_end * 1000).format("ll")
		
		if (sub.plan) { 
			sub.plan.amount = (sub.plan.amount / 100).toLocaleString('en-US', { 
				style: 'currency', 
				currency: 'USD'
			})
		}

		return sub
	})

	let allInvoices = await stripe.invoices.list({
		customer: customerId,
		limit: 5 
	})

	// Add upcoming invoice
	try {
		let upcomingInvoice = await stripe.invoices.retrieveUpcoming(customerId)
		allInvoices.data.unshift(upcomingInvoice)
	} catch(e) {
		console.log('User has no usage yet.')
	}

	allInvoices = allInvoices.data
	.filter(invoice => invoice.amount_due > 0) // Only show 'real' invoices 
	.map(invoice => {
		invoice.amount = (invoice.amount_due / 100).toLocaleString('en-US', { 
			style: 'currency', 
			currency: 'USD'
		})

		// Because the invoice's own period isn't correct for the first invoice, we use the one from the first item
		invoice.cleanPeriodEnd = moment(invoice.lines.data[0].period.end * 1000).format('ll')
		invoice.cleanPeriodStart = moment(invoice.lines.data[0].period.start * 1000).format('ll')

		invoice.date = moment(invoice.date * 1000).format('ll')
		invoice.unpaid = (invoice.attempt_count > 1)

		return invoice
	})

	return {
		sources: sources,
		invoices: allInvoices,
		subscriptions: subscriptions,
		user: user,
		options: options
	}

}

router.use((req, res, next) => {
	if (!req.user) return next('Login required for billing.')

	res.locals.customerId = req.user.stripeCustomerId || (req.user.stripe ? req.user.stripe.customerId : null)
	res.locals.subscriptionId = req.user.subscription || (req.user.stripe ? req.user.stripe.subscriptionId : null)
	next()
})

router.get('/', asyncHandler(async (req, res, next) => {

	const customerId = res.locals.customerId
	const data = await billing(customerId, req.user)

	res.render(__dirname+'/billing.ejs', data)
}))

const addCardToCustomer = async (user, customerId, token) => {
	
	let stripe = Stripe(options.secretKey)
	let customer = null

	if (customerId) {

		customer = await stripe.customers.update(customerId, { source: token })
	
	} else {
		customer = await stripe.customers.create({ email: user.email, source: token })

		let dbUser = await options.mongoUser.findById(user.id).exec()
		
		dbUser.stripe.customerId = customer.id
		
		await dbUser.save()
	}

	return customer
}


router.post('/upgrade', asyncHandler(async (req, res, next) => {

	let token = req.body.stripeToken
	let customerId = res.locals.customerId

	if (!customerId && !token) return next("Sorry! We need a credit card to subscribe you.")

	// If the customer doesn't have card or isn't a Stripe customer
	if (token) { 
		try {
			var customer = await addCardToCustomer(req.user, customerId, token)
		} catch(e) {
			return next("Sorry, we couldn't process your credit card. Please check with your bank.")
		}

		customerId = customer.id
	}

	let dbUser = await options.mongoUser.findById(req.user.id).exec()

	let planId = req.body.upgradePlan

	let plan = options.plans.find(plan => plan.id === planId)
	if (!plan) return next('Invalid plan.')

	let stripe = Stripe(options.secretKey)

	let subscriptionId = res.locals.subscriptionId

	if (subscriptionId) {

		var subscription = await stripe.subscriptions.retrieve(subscriptionId)

		await stripe.subscriptions.update(subscriptionId, {
			items: [{
				id: subscription.items.data[0].id,
				plan: plan.stripeId
			}]
		})

	} else {

		var subscription = await stripe.subscriptions.create({
								customer: customerId,
								items: [{ plan: plan.stripeId }]
							})
	}

	dbUser.plan = plan.id
	dbUser.stripe.subscriptionId = subscription.id

	await dbUser.save()

	sendMail("Thank you for upgrading 🚀", `Hello,\n\nThis is a confirmation email that you have successfully upgraded your account to the ${plan.name} plan :)\n\nIf you have any question or suggestion, just send me an email (or reply to this one).\n\nGlad to have you on board!`, dbUser.email)

	res.send({})

}))

router.post('/card', asyncHandler(async (req, res, next) => {

	let token = req.body.stripeToken
	let customerId = res.locals.customerId

	try {
		await addCardToCustomer(req.user, customerId, token)
	} catch(e) {
		return next(e)
	}

	res.send({})
}))

router.post('/webhook', asyncHandler(async (req, res, next) => {

	// Make sure event is signed
	let sig = request.headers["stripe-signature"]
	let event = stripe.webhooks.constructEvent(req.body, sig, options.webhookSecret)

	let type =event.type
	console.log('Receive new event from stripe: '+type)
	// console.log(req.body)

	if (type === 'customer.subscription.trial_will_end') {
		
		// Send email for ending trial
		// sendMail(`Your trial is ending - ${options.siteName}`, `Hello,\n\nThis is an email to let you know that your ${options.siteName} trial will be ending soon.\n\nIf you do not wish to continue, you can cancel your subscription now in your dashboard. Else, you don't have anything to do :)\n\nCheers`, dbUser.email)

	} else if (type === 'customer.source.expiring') {

		// Send email for credit card expiring
		// Already handled by Stripe

	} else if (type === 'invoice.payment_failed') {
		
		// Send email for failed invoice payment
		// Already handled by Stripe
	
	} else if (type === 'customer.subscription.deleted') {

		let customerId = event.data.object.customer
		let subscriptionId = event.data.object.id

		let user = await mongoUser.findOne({'stripe.customerId': customer}).exec()
		
		if (user.plan) user.plan = 'free'
		user.stripe.subscriptionId = null
		user.stripe.subscriptionItems = []
		user.save()

		sendMail(`Subscription canceled - ${options.siteName}`, `Hello,\n\nThis is an automatic confirmation email to inform you that your ${options.siteName} subscription was canceled.\n\nWe hope to see you back soon!`, user.email)

	}

	res.send({ received: true })
}))

router.get('/chooseplan', asyncHandler(async (req, res, next) => {

	let customerId = res.locals.customerId

	let data = await billing(customerId, req.user)

	data.redirect = options.choosePlanRedirect

	res.render(__dirname+'/chooseplan', data)
}))

router.get('/billing.js', (req, res, next) => {
	res.sendFile(__dirname+'/billing.js')
})

module.exports = (opts) => {
	if (opts) options = opts

	sendMail = options.sendMail || function () {}

	return router
}