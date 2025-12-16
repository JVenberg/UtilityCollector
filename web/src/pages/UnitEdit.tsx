import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useUnits } from '../hooks/useUnits';
import type { Unit, TrashCan } from '../types';

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
    trash_cans: [],
  });

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load existing unit data
  useEffect(() => {
    if (existingUnit) {
      setFormData({
        name: existingUnit.name,
        sqft: existingUnit.sqft,
        submeter_id: existingUnit.submeter_id,
        email: existingUnit.email,
        trash_cans: existingUnit.trash_cans || [],
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

  const handleTrashCanChange = (index: number, field: keyof TrashCan, value: string | number) => {
    setFormData(prev => {
      const updatedTrashCans = [...prev.trash_cans];
      updatedTrashCans[index] = {
        ...updatedTrashCans[index],
        [field]: field === 'size' ? Number(value) : value,
      };
      return { ...prev, trash_cans: updatedTrashCans };
    });
  };

  const addTrashCan = () => {
    setFormData(prev => ({
      ...prev,
      trash_cans: [...prev.trash_cans, { service_type: 'Garbage', size: 32 }],
    }));
  };

  const removeTrashCan = (index: number) => {
    setFormData(prev => ({
      ...prev,
      trash_cans: prev.trash_cans.filter((_, i) => i !== index),
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
          <div className="flex justify-between items-center">
            <h2 className="text-lg font-medium text-gray-900">Trash Cans</h2>
            <button
              type="button"
              onClick={addTrashCan}
              className="text-sm text-blue-600 hover:text-blue-800"
            >
              + Add Trash Can
            </button>
          </div>

          {formData.trash_cans.length === 0 ? (
            <p className="text-gray-500 text-sm">No trash cans configured for this unit.</p>
          ) : (
            <div className="space-y-4">
              {formData.trash_cans.map((trashCan, index) => (
                <div key={index} className="flex items-end gap-4 p-4 bg-gray-50 rounded-lg">
                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700">
                      Service Type
                    </label>
                    <select
                      value={trashCan.service_type}
                      onChange={(e) => handleTrashCanChange(index, 'service_type', e.target.value)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    >
                      <option value="Garbage">Garbage</option>
                      <option value="Recycle">Recycle</option>
                      <option value="Compost">Compost</option>
                    </select>
                  </div>

                  <div className="flex-1">
                    <label className="block text-sm font-medium text-gray-700">
                      Size (Gallons)
                    </label>
                    <select
                      value={trashCan.size}
                      onChange={(e) => handleTrashCanChange(index, 'size', e.target.value)}
                      className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                    >
                      <option value="13">13 Gal</option>
                      <option value="20">20 Gal</option>
                      <option value="32">32 Gal</option>
                      <option value="64">64 Gal</option>
                      <option value="96">96 Gal</option>
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={() => removeTrashCan(index)}
                    className="text-red-600 hover:text-red-800 p-2"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
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
