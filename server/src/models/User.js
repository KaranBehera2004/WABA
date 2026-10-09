import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 80 },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 8, select: false },
  role: { type: String, enum: ['superadmin', 'owner', 'admin', 'agent', 'supervisor'], default: 'owner' },
  sessionVersion: { type: Number, default: 0 },
  workspaceProvisionVersion: { type: Number, default: 0, select: false },
  company: { type: String, trim: true, maxlength: 120 },
  defaultWorkspace: { type: mongoose.Schema.Types.ObjectId, ref: 'Workspace' },
  isActive: { type: Boolean, default: true },
  deletedAt: Date,
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  autoWorkspaceCreationBlocked: { type: Boolean, default: false },
  lastLoginAt: Date,
}, { timestamps: true });

userSchema.pre('save', async function hashPassword(next) {
  if (!this.isModified('password')) return next();
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

userSchema.methods.comparePassword = function comparePassword(candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.toSafeObject = function toSafeObject() {
  return { id: this._id, name: this.name, email: this.email, role: this.role, company: this.company, workspaceId: this.defaultWorkspace };
};

export default mongoose.model('User', userSchema);
