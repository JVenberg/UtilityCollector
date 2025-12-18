import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useUnits } from '../hooks/useUnits';
import type { Unit, SolidWasteDefaults } from '../types';

// Default solid waste configuration
const DEFAULT_SOLID_WASTE: SolidWasteDefaults = {
  garbage_size: 32,
  compost_size: 13,
  recycle_size: 90,
};

// Available sizes for each service type
const GARBAGE_SIZES = [20, 32, 60, 96];
const COMPOST_SIZES = [13, 32];
const RECYCLE_SIZES = [90];

export function UnitEdit() {
  const { unitId } = useParams<{ unitId: string }>();
  const navigate = useNavigate();
  const { units, loading: unitsLoading, addUnit, updateUnit, deleteUnit } = useUnits();

  const isNew = unitId === 'new';
  const existingUnit = !isNew ? units.find(u => u.id === unitId) : undefined;

  const [formData, setFormData] = useState<Omit<Unit, 'id' | 'created_at'>>({
    name: '',
    sqft: 0,
    submeter_id: '',
    email: '',
    trash_cans: [], // Legacy field, kept for backward compatibility
    solid_waste_defaults: DEFAULT_SOLID_WASTE,
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load existing unit data
  useEffect(() => {
    if (existingUnit) {
      // Migrate from legacy trash_cans to solid_waste_defaults if needed
      let solidWasteDefaults = existingUnit.solid_waste_defaults;
      if (!solidWasteDefaults && existingUnit.trash_cans?.length) {
        // Try to migrate from legacy format
        const garbageCan = existingUnit.trash_cans.find(tc => tc.service_type === 'Garbage');
        const compostCan = existingUnit.trash_cans.find(tc => tc.service_type === 'Compost');
        const recycleCan = existingUnit.trash_cans.find(tc => tc.service_type === 'Recycle');
        solidWasteDefaults = {
          garbage_size: garbageCan?.size || DEFAULT_SOLID_WASTE.garbage_size,
          compost_size: compostCan?.size || DEFAULT_SOLID_WASTE.compost_size,
          recycle_size: recycleCan?.size || DEFAULT_SOLID_WASTE.recycle_size,
        };
      }
      
      setFormData({
        name: existingUnit.name,
        sqft: existingUnit.sqft,
        submeter_id: existingUnit.submeter_id,
        email: existingUnit.email,
        trash_cans: existingUnit.trash_cans || [],
        solid_waste_defaults: solidWasteDefaults || DEFAULT_SOLID_WASTE,
      });
    }
  }, [existingUnit]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: type === 'number' ? Number(value) : value,
    }));
  };

  const handleSolidWasteChange = (field: keyof SolidWasteDefaults, value: number) => {
    setFormData(prev => ({
      ...prev,
      solid_waste_defaults: {
        ...(prev.solid_waste_defaults || DEFAULT_SOLID_WASTE),
        [field]: value,
      },
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);

    try {
      if (isNew) {
        await addUnit(formData);
      } else if (unitId) {
        await updateUnit(unitId, formData);
      }
      navigate('/units');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save unit');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!unitId || isNew) return;

    if (!confirm('Are you sure you want to delete this unit?')) return;

    setSaving(true);
    setError(null);

    try {
      await deleteUnit(unitId);
      navigate('/units');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete unit');
      setSaving(false);
    }
  };

  if (unitsLoading && !isNew) {
    return (
      <div className="flex justify-center items-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!isNew && !existingUnit && !unitsLoading) {
    return (
      <div className="text-center py-12">
        <h1 className="text-2xl font-bold text-gray-900">Unit Not Found</h1>
        <button
          onClick={() => navigate('/units')}
          className="mt-4 text-blue-600 hover:underline"
        >
          Back to Units
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">
        {isNew ? 'Add New Unit' : `Edit ${formData.name}`}
      </h1>

      {error && (
        <div className="mb-4 p-4 bg-red-100 text-red-700 rounded-lg">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-white shadow rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-medium text-gray-900">Unit Details</h2>

          <div>
            <label htmlFor="name" className="block text-sm font-medium text-gray-700">
              Unit Name
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              required
              placeholder="e.g., Unit 401"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="sqft" className="block text-sm font-medium text-gray-700">
              Square Feet
            </label>
            <input
              type="number"
              id="sqft"
              name="sqft"
              value={formData.sqft}
              onChange={handleChange}
              required
              min="0"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="submeter_id" className="block text-sm font-medium text-gray-700">
              Submeter ID
            </label>
            <input
              type="text"
              id="submeter_id"
              name="submeter_id"
              value={formData.submeter_id}
              onChange={handleChange}
              required
              placeholder="e.g., SM-401"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-gray-700">
              Tenant Email
            </label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              required
              placeholder="tenant@example.com"
              className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
            />
          </div>
        </div>

        <div className="bg-white shadow rounded-lg p-6 space-y-4">
          <h2 className="text-lg font-medium text-gray-900">Solid Waste Services</h2>
          <p className="text-sm text-gray-500">
            Configure the container sizes for this unit. Each unit must have exactly one of each service type.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Garbage */}
            <div className="p-4 bg-gray-50 rounded-lg">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                🗑️ Garbage
              </label>
              <select
                value={formData.solid_waste_defaults?.garbage_size || DEFAULT_SOLID_WASTE.garbage_size}
                onChange={(e) => handleSolidWasteChange('garbage_size', Number(e.target.value))}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
              >
                {GARBAGE_SIZES.map(size => (
                  <option key={size} value={size}>{size} Gal</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400">Weekly pickup</p>
            </div>

            {/* Compost (Food/Yard Waste) */}
            <div className="p-4 bg-green-50 rounded-lg">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                🌱 Compost (Food/Yard Waste)
              </label>
              <select
                value={formData.solid_waste_defaults?.compost_size || DEFAULT_SOLID_WASTE.compost_size}
                onChange={(e) => handleSolidWasteChange('compost_size', Number(e.target.value))}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
              >
                {COMPOST_SIZES.map(size => (
                  <option key={size} value={size}>{size} Gal</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400">Weekly pickup</p>
            </div>

            {/* Recycle */}
            <div className="p-4 bg-blue-50 rounded-lg">
              <label className="block text-sm font-medium text-gray-700 mb-2">
                ♻️ Recycle
              </label>
              <select
                value={formData.solid_waste_defaults?.recycle_size || DEFAULT_SOLID_WASTE.recycle_size}
                onChange={(e) => handleSolidWasteChange('recycle_size', Number(e.target.value))}
                className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
              >
                {RECYCLE_SIZES.map(size => (
                  <option key={size} value={size}>{size} Gal</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400">Every other week (free)</p>
            </div>
          </div>
        </div>

        <div className="flex justify-between">
          <div>
            {!isNew && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="px-4 py-2 text-red-600 hover:text-red-800 disabled:opacity-50"
              >
                Delete Unit
              </button>
            )}
          </div>

          <div className="flex gap-4">
            <button
              type="button"
              onClick={() => navigate('/units')}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? 'Saving...' : (isNew ? 'Create Unit' : 'Save Changes')}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
