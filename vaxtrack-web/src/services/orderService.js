import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  serverTimestamp,
  updateDoc,
  where,
  query,
} from "firebase/firestore";
import { db } from "../firebase";

const ORDERS_COLLECTION = "orders";

export async function createSalesRepOrder(orderData = {}) {
  if (!orderData.clinicName) {
    throw new Error("Clinic name is required.");
  }
  if (!orderData.vaccineName) {
    throw new Error("Vaccine name is required.");
  }
  if (!orderData.quantity || orderData.quantity <= 0) {
    throw new Error("Quantity must be greater than zero.");
  }

  const orderNumber = orderData.orderNumber || `VT-ORD-${Date.now()}`;

  const doc = {
    orderNumber,
    clinicName: orderData.clinicName,
    clinicAddress: orderData.clinicAddress || "",
    vaccineName: orderData.vaccineName,
    vaccineType: orderData.vaccineType || "",
    quantity: Number(orderData.quantity),
    unit: orderData.unit || "vials",
    storageTemp: orderData.storageTemp || "",
    priority: orderData.priority || "Standard",

    status: "pending_dispatch",

    assignedRiderId: null,
    assignedRiderName: null,

    createdByRole: "sales_rep",
    createdByUid: orderData.createdByUid || null,
    createdByEmail: orderData.createdByEmail || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  if (orderData.region) {
    doc.region = orderData.region;
  }

  if (orderData.deliveryInstructions) {
    doc.deliveryInstructions = orderData.deliveryInstructions;
  }

  if (Array.isArray(orderData.items) && orderData.items.length > 0) {
    doc.items = orderData.items.map((item) => ({
      name: item.name || "",
      sku: item.sku || "",
      chain: item.chain || item.temp || item.category || "",
      quantity: Number(item.quantity) || 0,
      unitPrice: Number(item.unitPrice) || 0,
    }));
  }

  return addDoc(collection(db, ORDERS_COLLECTION), doc);
}

export function subscribePendingDispatchOrders(callback) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("status", "==", "pending_dispatch")
  );

  return onSnapshot(q, (snapshot) => {
    const orders = snapshot.docs.map((docItem) => ({
      id: docItem.id,
      ...docItem.data(),
    }));

    callback(orders);
  });
}

export async function assignRiderToOrder(orderId, rider) {
  if (!orderId) {
    throw new Error("Order ID is required.");
  }

  const orderRef = doc(db, ORDERS_COLLECTION, orderId);

  return updateDoc(orderRef, {
    status: "assigned",
    assignedRiderId: rider.id,
    assignedRiderName: rider.name,
    assignedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export function subscribeAssignedRiderOrders(riderId, callback) {
  const q = query(
    collection(db, ORDERS_COLLECTION),
    where("assignedRiderId", "==", riderId)
  );

  return onSnapshot(q, (snapshot) => {
    const orders = snapshot.docs
      .map((docItem) => ({
        id: docItem.id,
        ...docItem.data(),
      }))
      .filter(
        (order) => order.status === "assigned" || order.status === "in_transit"
      );

    callback(orders);
  });
}

export async function startRiderDelivery(orderId) {
  if (!orderId) {
    throw new Error("Order ID is required.");
  }

  const orderRef = doc(db, ORDERS_COLLECTION, orderId);

  return updateDoc(orderRef, {
    status: "in_transit",
    startedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}