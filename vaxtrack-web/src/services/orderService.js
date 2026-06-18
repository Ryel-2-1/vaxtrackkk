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
  return addDoc(collection(db, ORDERS_COLLECTION), {
    orderNumber: orderData.orderNumber || `VT-ORD-${Date.now()}`,
    clinicName: orderData.clinicName || "St. Luke's Medical Center - QC",
    clinicAddress:
      orderData.clinicAddress ||
      "279 E Rodriguez Sr. Ave, Quezon City, Metro Manila",
    vaccineName: orderData.vaccineName || "Vaxipro Ultra-V Adult",
    vaccineType: orderData.vaccineType || "Cold Chain Vaccine",
    quantity: orderData.quantity || 660,
    unit: orderData.unit || "vials",
    storageTemp: orderData.storageTemp || "2°C - 8°C",
    priority: orderData.priority || "Urgent",

    status: "pending_dispatch",

    assignedRiderId: null,
    assignedRiderName: null,

    createdByRole: "sales_rep",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
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