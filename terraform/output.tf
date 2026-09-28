output "public_ip" {
  value = aws_eip.eip.public_ip
}

output "monitoring_public_ip" {
  value = aws_eip.monitoring.public_ip
}