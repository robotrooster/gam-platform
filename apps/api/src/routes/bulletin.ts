import { Router } from 'express'
import { query, queryOne } from '../db'
import { requireAuth, requireTenant } from '../middleware/auth'
import { AppError } from '../middleware/errorHandler'

export const bulletinRouter = Router()
bulletinRouter.use(requireAuth)

// ── Alias generator ───────────────────────────────────────────
const ADJ = ['Able', 'Absent', 'Abstract', 'Acidic', 'Active', 'Actual', 'Adamant', 'Adept', 'Adorable', 'Adroit', 'Aged', 'Agile', 'Airy', 'Alert', 'Alive', 'Allied', 'Aloof', 'Alpine', 'Altruistic', 'Amber', 'Ample', 'Ancient', 'Angular', 'Anxious', 'Ardent', 'Arid', 'Astute', 'Atomic', 'Audacious', 'Austere', 'Authentic', 'Aware', 'Awful', 'Awkward', 'Azure', 'Balanced', 'Barren', 'Basic', 'Blazing', 'Bleak', 'Blissful', 'Blithe', 'Blunt', 'Bold', 'Bountiful', 'Brave', 'Breezy', 'Brief', 'Bright', 'Brisk', 'Brittle', 'Bronze', 'Buoyant', 'Calm', 'Candid', 'Capable', 'Carefree', 'Careful', 'Cautious', 'Cedar', 'Celestial', 'Cheerful', 'Cinder', 'Classic', 'Clear', 'Clever', 'Cobalt', 'Cold', 'Colorful', 'Complex', 'Composed', 'Coral', 'Courageous', 'Crisp', 'Crimson', 'Crystal', 'Curious', 'Daring', 'Dark', 'Dashing', 'Dawn', 'Dauntless', 'Dazzling', 'Deep', 'Deliberate', 'Dense', 'Devoted', 'Diligent', 'Dim', 'Direct', 'Distinct', 'Dormant', 'Durable', 'Dusty', 'Dynamic', 'Eager', 'Early', 'Earnest', 'Earthy', 'Ebony', 'Effortless', 'Elegant', 'Ember', 'Eminent', 'Enduring', 'Energetic', 'Enigmatic', 'Ethereal', 'Even', 'Exact', 'Exemplary', 'Exotic', 'Expert', 'Extreme', 'Faint', 'Faithful', 'Fearless', 'Fern', 'Fervent', 'Fierce', 'Fixed', 'Flint', 'Flowing', 'Fluid', 'Focused', 'Forceful', 'Formal', 'Fragrant', 'Frank', 'Free', 'Fresh', 'Frigid', 'Frosty', 'Frugal', 'Full', 'Gentle', 'Genuine', 'Gifted', 'Gilded', 'Glacial', 'Gleaming', 'Glowing', 'Golden', 'Graceful', 'Granite', 'Grateful', 'Gravel', 'Grounded', 'Hardy', 'Hazy', 'Heartfelt', 'Heavy', 'Helpful', 'Hidden', 'Hollow', 'Honest', 'Hopeful', 'Humble', 'Hushed', 'Icy', 'Idle', 'Illumined', 'Immense', 'Impartial', 'Infinite', 'Ingenious', 'Innate', 'Intense', 'Intrepid', 'Inventive', 'Iron', 'Isolated', 'Ivory', 'Jade', 'Jolly', 'Just', 'Keen', 'Kind', 'Knowing', 'Lively', 'Lofty', 'Lone', 'Loyal', 'Lucid', 'Luminous', 'Lunar', 'Lush', 'Mellow', 'Mighty', 'Mindful', 'Minimal', 'Misty', 'Mossy', 'Murky', 'Natural', 'Noble', 'Nomadic', 'Nurtured', 'Observant', 'Ochre', 'Olive', 'Onyx', 'Opal', 'Open', 'Orderly', 'Organic', 'Original', 'Pale', 'Patient', 'Peaceful', 'Pensive', 'Persistent', 'Pewter', 'Pine', 'Plain', 'Polished', 'Precise', 'Primal', 'Prime', 'Pristine', 'Profound', 'Proud', 'Pure', 'Quiet', 'Radiant', 'Rapid', 'Rational', 'Ragged', 'Refined', 'Relaxed', 'Reliable', 'Remote', 'Resilient', 'Resolute', 'Restful', 'Rigid', 'Rocky', 'Rosy', 'Rugged', 'Rustic', 'Rusty', 'Sage', 'Sandy', 'Scarlet', 'Serene', 'Sharp', 'Shrewd', 'Silent', 'Silver', 'Simple', 'Sincere', 'Sleek', 'Slim', 'Smoky', 'Smooth', 'Solar', 'Somber', 'Spirited', 'Splendid', 'Spontaneous', 'Stalwart', 'Stark', 'Steadfast', 'Stoic', 'Stony', 'Storm', 'Strong', 'Subtle', 'Sunlit', 'Sure', 'Supple', 'Swift', 'Tawny', 'Tenacious', 'Tender', 'Thankful', 'Thorough', 'Timber', 'Timeless', 'Tranquil', 'Twilight', 'Umber', 'Unbound', 'Unique', 'Upright', 'Valiant', 'Vast', 'Verdant', 'Vibrant', 'Vigilant', 'Vivid', 'Wandering', 'Warm', 'Weathered', 'Wild', 'Winding', 'Wise', 'Worthy', 'Woven', 'Worn', 'Xenial', 'Yielding', 'Zephyr', 'Zesty', 'Zealous', 'Nimble', 'Stable', 'Untamed', 'Velvet', 'Wistful', 'Blazing', 'Crisp', 'Lucent', 'Muted', 'Nuanced', 'Peerless', 'Regal', 'Sacred', 'Timid', 'Vivacious']
const ANI = ['Aardvark', 'Albatross', 'Alligator', 'Alpaca', 'Anaconda', 'Antelope', 'Armadillo', 'Axolotl', 'Baboon', 'Badger', 'Bantam', 'Barracuda', 'Bat', 'Bear', 'Beaver', 'Bison', 'Bobcat', 'Bonobo', 'Buffalo', 'Bullfrog', 'Capybara', 'Caracal', 'Cassowary', 'Catfish', 'Chameleon', 'Cheetah', 'Chinchilla', 'Chipmunk', 'Civet', 'Cobra', 'Cockatoo', 'Condor', 'Coyote', 'Crane', 'Crocodile', 'Dingo', 'Dolphin', 'Donkey', 'Dormouse', 'Dunnock', 'Eagle', 'Egret', 'Elk', 'Emu', 'Ermine', 'Falcon', 'Ferret', 'Finch', 'Fisher', 'Flamingo', 'Fox', 'Gecko', 'Gerbil', 'Gibbon', 'Giraffe', 'Gnu', 'Gopher', 'Goshawk', 'Grouse', 'Guanaco', 'Hamster', 'Harrier', 'Hawk', 'Hedgehog', 'Heron', 'Hippo', 'Hoopoe', 'Hornbill', 'Hyena', 'Ibis', 'Iguana', 'Impala', 'Jackal', 'Jaguar', 'Jerboa', 'Kestrel', 'Kingfisher', 'Kinkajou', 'Kite', 'Kiwi', 'Koala', 'Komodo', 'Kudu', 'Lemur', 'Leopard', 'Linnet', 'Lion', 'Llama', 'Lynx', 'Macaw', 'Manatee', 'Mandrill', 'Marmot', 'Marten', 'Meerkat', 'Merlin', 'Mink', 'Mole', 'Mongoose', 'Moose', 'Narwhal', 'Newt', 'Nightjar', 'Ocelot', 'Okapi', 'Opossum', 'Osprey', 'Otter', 'Pangolin', 'Panther', 'Parrot', 'Peacock', 'Pelican', 'Penguin', 'Peregrine', 'Pheasant', 'Platypus', 'Plover', 'Porcupine', 'Pronghorn', 'Puffin', 'Quail', 'Quetzal', 'Quoll', 'Rabbit', 'Raccoon', 'Raven', 'Redstart', 'Reindeer', 'Rhinoceros', 'Roadrunner', 'Salamander', 'Sandpiper', 'Serval', 'Shrike', 'Skunk', 'Sloth', 'Sparrow', 'Starling', 'Stoat', 'Tanager', 'Tapir', 'Tarsier', 'Thrush', 'Tiger', 'Toucan', 'Uakari', 'Urial', 'Viper', 'Vole', 'Vulture', 'Wallaby', 'Walrus', 'Warbler', 'Warthog', 'Weasel', 'Wildebeest', 'Wolf', 'Wolverine', 'Wombat', 'Woodcock', 'Woodpecker', 'Xerus', 'Yak', 'Zebra', 'Zebu', 'Panda', 'Chimpanzee', 'Gorilla', 'Orangutan', 'Macaque', 'Coati', 'Binturong', 'Fossa', 'Numbat', 'Quokka', 'Bandicoot', 'Bilby', 'Dhole', 'Bongo', 'Eland', 'Sable', 'Gemsbok', 'Springbok', 'Klipspringer', 'Nyala', 'Bushbuck', 'Oriole', 'Grosbeak', 'Siskin', 'Bullfinch', 'Avocet', 'Stilt', 'Jacana', 'Sunbird', 'Fantail', 'Drongo', 'Flycatcher', 'Pitta', 'Manakin', 'Anteater', 'Tamandua', 'Viscacha', 'Paca', 'Agouti', 'Coypu', 'Muskrat', 'Wren', 'Nuthatch', 'Dipper', 'Veery', 'Bluebird', 'Catbird', 'Thrasher', 'Mockingbird', 'Myna', 'Oxpecker', 'Bobolink', 'Lark', 'Pipit', 'Wagtail', 'Whydah', 'Weaver', 'Quelea', 'Mannikin', 'Munia', 'Waxbill', 'Cordon-bleu', 'Zorilla', 'Zorino', 'Tasmanian-Devil', 'Potoroo', 'Sitatunga', 'Oribi', 'Lapwing', 'Dunlin', 'Godwit', 'Turnstone', 'Crossbill', 'Redpoll', 'Cotinga', 'Antbird', 'Ovenbird', 'Pacarana', 'Hutia', 'Treecreeper', 'Kinglet', 'Gnatcatcher', 'Solitaire', 'Meadowlark', 'Cowbird', 'Grackle', 'Longclaw', 'Bishop', 'Pytilia', 'Snowy-Owl', 'Sunbear', 'Prairie-Dog', 'Flying-Fox', 'Dik-dik', 'Zebrafish', 'Sturgeon', 'Barracuda', 'Tarpon', 'Marlin', 'Sailfish', 'Tuna', 'Swordfish', 'Manta', 'Stingray', 'Hammerhead', 'Moray', 'Pufferfish', 'Triggerfish', 'Parrotfish', 'Clownfish', 'Lionfish', 'Seahorse', 'Cuttlefish', 'Nautilus', 'Crayfish', 'Lobster', 'Hermit-Crab', 'Fiddler-Crab', 'Mantis-Shrimp', 'Firefly', 'Dragonfly', 'Damselfly', 'Praying-Mantis', 'Tarantula', 'Scorpion', 'Centipede', 'Millipede', 'Silkworm', 'Monarch', 'Morpho', 'Atlas-Moth', 'Stick-Insect', 'Leafcutter-Ant', 'Bullet-Ant']
function randomAlias() {
  return ADJ[Math.floor(Math.random()*ADJ.length)] + ANI[Math.floor(Math.random()*ANI.length)]
}

// ── GET /api/bulletin?scope=property|city|state ───────────────
bulletinRouter.get('/', requireTenant, async (req, res, next) => {
  try {
    const scope = (req.query.scope as string) || 'property'
    if (!['property','city','state'].includes(scope)) throw new AppError(400, 'Invalid scope')

    const tenant = await queryOne<any>(
      `SELECT t.id, t.property_id, p.city, p.state
       FROM tenants t
       JOIN units u ON u.id = t.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE t.user_id = $1`, [req.user!.userId]
    )
    if (!tenant) throw new AppError(404, 'Tenant not found')

    const flagged = await query<any>(
      `SELECT post_id FROM bulletin_flags WHERE tenant_id = $1`, [tenant.id]
    )
    const flaggedSet = new Set((flagged as any[]).map((f: any) => f.post_id))

    let posts: any[]
    if (scope === 'property') {
      posts = await query<any>(
        `SELECT id, scope, alias, content, flag_count, created_at
         FROM bulletin_posts
         WHERE property_id = $1 AND scope = 'property'
         ORDER BY created_at DESC LIMIT 100`, [tenant.property_id]
      )
    } else if (scope === 'city') {
      posts = await query<any>(
        `SELECT id, scope, alias, content, flag_count, created_at
         FROM bulletin_posts
         WHERE city = $1 AND state = $2 AND scope = 'city'
         ORDER BY created_at DESC LIMIT 100`, [tenant.city, tenant.state]
      )
    } else {
      posts = await query<any>(
        `SELECT id, scope, alias, content, flag_count, created_at
         FROM bulletin_posts
         WHERE state = $1 AND scope = 'state'
         ORDER BY created_at DESC LIMIT 100`, [tenant.state]
      )
    }

    const result = (posts as any[]).map((p: any) => ({
      ...p,
      flagged_by_me: flaggedSet.has(p.id)
    }))

    res.json({ success: true, data: result })
  } catch(e) { next(e) }
})

// ── POST /api/bulletin ────────────────────────────────────────
bulletinRouter.post('/', requireTenant, async (req, res, next) => {
  try {
    const { scope, content } = req.body
    if (!['property','city','state'].includes(scope)) throw new AppError(400, 'Invalid scope')
    if (!content || content.trim().length < 3) throw new AppError(400, 'Content too short')
    if (content.length > 500) throw new AppError(400, 'Content too long (max 500 chars)')

    const tenant = await queryOne<any>(
      `SELECT t.id, t.property_id, p.city, p.state
       FROM tenants t
       JOIN units u ON u.id = t.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE t.user_id = $1`, [req.user!.userId]
    )
    if (!tenant) throw new AppError(404, 'Tenant not found')

    const alias = randomAlias()
    const [post] = await query<any>(
      `INSERT INTO bulletin_posts (tenant_id, property_id, city, state, scope, content, alias)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, scope, alias, content, flag_count, created_at`,
      [tenant.id, tenant.property_id, tenant.city, tenant.state, scope, content.trim(), alias]
    )

    res.status(201).json({ success: true, data: { ...post, flagged_by_me: false } })
  } catch(e) { next(e) }
})

// ── POST /api/bulletin/:id/flag ───────────────────────────────
bulletinRouter.post('/:id/flag', requireTenant, async (req, res, next) => {
  try {
    const tenant = await queryOne<any>(
      `SELECT t.id FROM tenants t WHERE t.user_id = $1`, [req.user!.userId]
    )
    if (!tenant) throw new AppError(404, 'Tenant not found')

    await query(
      `INSERT INTO bulletin_flags (post_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, tenant.id]
    )
    await query(
      `UPDATE bulletin_posts SET flag_count = (SELECT COUNT(*) FROM bulletin_flags WHERE post_id=$1) WHERE id=$1`,
      [req.params.id]
    )

    res.json({ success: true })
  } catch(e) { next(e) }
})

// ── GET /api/bulletin/:id/reveal — super_admin only ──────────
bulletinRouter.get('/:id/reveal', async (req, res, next) => {
  try {
    if (!req.user?.permissions?.super_admin) throw new AppError(403, 'Super admin access required')

    const post = await queryOne<any>(
      `SELECT bp.id, bp.alias, bp.content, bp.created_at, bp.scope,
              u.first_name, u.last_name, u.email, u.phone,
              un.unit_number, p.name as property_name
       FROM bulletin_posts bp
       JOIN tenants t ON t.id = bp.tenant_id
       JOIN users u ON u.id = t.user_id
       JOIN units un ON un.id = t.unit_id
       JOIN properties p ON p.id = bp.property_id
       WHERE bp.id = $1`, [req.params.id]
    )
    if (!post) throw new AppError(404, 'Post not found')

    res.json({ success: true, data: post })
  } catch(e) { next(e) }
})
